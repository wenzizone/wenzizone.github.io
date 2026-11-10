---
title: 玩转 ArgoCD 系列提纲（工作文档，不发布）
date: 2026-11-05 10:00:00
tags: [argocd, gitops, kubernetes]
categories: Devops
---

> 这是系列写作的**工作文档**，不是文章。换电脑后先读本文，再继续。
> 状态：提纲 v2（按作者的系列目标重新定位）；示例素材已补入（第 6、7 节）；下一步起草第 1 篇。

## 1. 定位与写法

- **语言**：中文。
- **系列目标（作者确认）**：
  1. 告诉大家**我认为的使用 ArgoCD 的正确方法**。
  2. **能用我已经实现的做例子，就用已经实现的**；没有实现的部分，不要揪着“我没做”来做文章，这违背了做这个系列的初衷。很多实践不在当前的仓库里，是在其他渠道已经跑通的，同样可以当作推荐做法直接讲。
- **读者**：新手与老手兼顾。每篇前半给新手（概念 + 最小示例），后半讲“我推荐怎么做、为什么”。每篇开头加一行导读，例如“新手读 1–3 节，有经验的直接看第 4 节起”。
- **风格**：以“正确做法”为主线，不写空泛介绍。每个关键点用小模板：**推荐做法 → 备选方案 → 为什么选它 → 适用边界**（边界指“什么时候不适合”，不是自我批评）。
- **系列形式**：参照已有的 Strimzi 系列（`strimzi-what-and-why.md`）：第一篇交代全系列脉络，最后一篇做总结（把各篇的推荐做法浓缩成清单）。
- **可关联的已有文章**：`run-karpenter-on-oke-with-argocd.md`、`use-external-dns-in-k8s.md`。

## 2. 脱敏规则（发布前必查）

以下内容一律换成示例值或泛称，不要写进草稿和文章：

- 集群 API 地址、内网 IP、公网 IP
- 镜像仓库地址（含租户 ID）
- 公司/业务域名、GitHub 组织名与仓库完整地址
- 任何 token、密码、Vault 路径的具体值
- 具体集群名与区域拓扑，统一写成“生产多区域 / qa / ops”这类泛称

## 3. 已核实的真实架构（写作依据，勿编造）

数据来自两个内部仓库：一个放 Application / ApplicationSet / AppProject（下称“apps 仓库”），一个放 Helm chart（下称“chart 仓库”）。

- **一套 ArgoCD** 部署在 ops 集群（in-cluster），统一管理多个 OKE 集群：生产多区域 + qa + ops，**不止 3 个**。ArgoCD 本身用 wrapper chart 部署，声明依赖官方 argo-cd chart 9.4.17（ArgoCD v3.3.6）。
- **两个仓库分工**：apps 仓库放 ApplicationSet / AppProject / addon 配置；chart 仓库放 Helm chart 与各集群的 values 文件。
- **App-of-Apps 结构**：
  - `init-*` 入口 Application（prod / qa / ops / oke-addon / project / cicd）各指向一个目录，递归拉起目录里所有 ApplicationSet。
  - 每个服务一个 ApplicationSet，业务服务统一用 list generator，一个 appset 最多覆盖 3 个集群。
  - 每个业务线一个 AppProject（如 prod-dsp、qa-adx）。
- **通用 chart（实际是“一套模板，逐步分叉”）**：最初的通用 chart 用开关控制 Deployment / Rollout / Ingress / HTTPRoute / HPA / ExternalSecret；后来各业务线各自分叉出自己的 chart，目前只有最早的那个业务目录直接使用通用 chart。**每个集群一个 values 文件**表达差异。详见第 7 节。
- **发布流水线（自研，不用 Image Updater）**：
  CI 构建镜像 → Argo Workflows 的通用部署模板 → 查 `deployment-mapping.yaml` 定位 appset → `yq` 修改 `image.tag` → 开分支、自动提 PR 并**开启自动合并**（`gh pr merge --auto`）→ ArgoCD 同步。**PR 不需要人工 review**（作者确认）：流程本身已定义好，并设计了快速回滚方案作为兜底（见 7.7）。appset 里还带 `ticket` 参数，把发布与工单关联。
- **同步策略并非一刀切**：生产 48 个 appset 中，32 个 `prune/selfHeal` 全关，16 个全开；qa 是 30 关 / 18 开。addon 类 29 个 appset 里 25 个全开。**注意：全关不等于关掉自动同步**——这些 appset 的 `automated` 块都在，只是 `prune: false`、`selfHeal: false`，Git 变更仍会自动落地，只是不自动删资源、不自动纠偏。第 6 篇的写法见 6.4。所有业务 appset 都忽略 `replicas`（给 HPA 让路），并统一启用 `ApplyOutOfSyncOnly`、`RespectIgnoreDifferences`。
- **Secret**：external-secrets 从 Vault 同步，按环境选 ClusterSecretStore，`refreshInterval` 为 10s；Secret 不进 Git。
- **渐进式发布**：通用 chart 里 `canary.enabled` 开关；Rollout 用 `workloadRef` 引用已有 Deployment；支持 Gateway API 或 nginx 做流量切分；steps 为 1% → 10% → 50%，每步手动 pause。
- **变更管理**：apps 仓库里用 openspec 管理较大的变更。

## 4. 提纲（v1）

| # | 主题 | 新手层 | 推荐做法与示例（优先用已实现的；其他渠道已跑通的做法同样直接讲） |
|---|---|---|---|
| 1 | 全景：我们的 ArgoCD 如何管多个集群 | GitOps 是什么；ArgoCD 架构 | 单控制面管多集群的整体图；两个仓库分工；一次发布的完整旅程概览 |
| 2 | App-of-Apps：入口 Application + 每服务一个 ApplicationSet | Application / ApplicationSet 概念 | `init-*` 入口；目录结构；新增一个服务要改哪些文件 |
| 3 | Helm Chart 怎么管：chart 随代码、按 tag 发布、不可变（以目标形态为结论） | Helm values 分层；chart 与代码是否同仓 | 结论先行：chart 与项目同仓、变动视为上线、生产按 tag 发版；开关式设计、每集群一个 values、分叉的取舍作为补充（见 7.2）；现状一笔带过 |
| 4 | 多集群多区域：list generator 怎么表达 | generator 种类对比 | 一个 appset 覆盖多个集群；为什么用 list 而不是 cluster/matrix |
| 5 | 发布流水线：Argo Workflows 自动提 PR 改 image.tag | Argo Events / Workflows 简介；Image Updater 是什么 | 通用部署模板全流程；mapping 文件；沿用 Jenkins 流式结构又兼顾 GitOps：推式流水线与拉式 GitOps 的折中（对比 Image Updater） |
| 6 | 同步策略：prune / selfHeal 到底是什么 | automated / prune / selfHeal 各自含义，三者关系 | 实际案例：selfHeal 与 HPA 的冲突（ignoreDifferences）、prune 的两面、入口 Application 的配置效果、升级窗口临时关 prune；不追究本环境为何这样设置 |
| 7 | Secret：External Secrets + Vault | Secret 不进 Git 的几种方案对比 | ExternalSecret 写法；ClusterSecretStore；10s 刷新的取舍 |
| 8 | Argo Rollouts：workloadRef + 金丝雀 | 金丝雀 vs 蓝绿 | chart 里 canary 开关；Gateway API 流量切分；什么样的服务适合上金丝雀 |
| 9 | AppProject 与权限划分 | Project / RBAC 概念 | 怎么按业务线 × 环境划分 Project 与 RBAC；SSO 按团队映射角色（见 7.6） |
| 10 | 总结：我心目中的 ArgoCD 正确姿势 | 全系列要点速查 | 把前 9 篇的推荐做法浓缩成一份检查清单，并标出各条对应的篇章 |

建议先写 **1、2、3**，连起来是完整的“仓库设计”主题；第 1 篇最有故事线，从一个 PR 的诞生讲到 Pod 滚动。

## 5. 写作原则（作者确认，写任何一篇前先读）

- **写“正确做法”，不写“审计报告”**：不拿仓库当检查对象，不写“我们的不足 / 没用到的特性 / 配置不一致”。
- **示例的来源**：
  - 仓库里已实现的，优先拿来做示例。
  - 仓库里没有、但在其他渠道已经跑通的做法，当作推荐做法直接讲，**不需要仓库里有对应代码，也不加“我们这里没做”之类的说明**。
  - 示意性的例子，在文中说清是“示意”，不要说成本环境当时的做法。
- **现状与目标**：目标形态是文章的结论；现状如果需要提，一笔带过，不展开成缺陷清单。
- **“边界”不是“自我批评”**：讲一个做法时，可以写“什么场景下它不适合”，这是帮读者判断，不是在检讨自己。
- **事实要准**：示例引用仓库里的事实时要核对；机制类论述（官方行为）发布前对照官方文档。

## 6. 素材库 A：apps 仓库（已脱敏）

### 6.1 规模数字（可放进第 1 篇开头）

- 全仓库约 210 个 yaml，其中 **ApplicationSet 129 个**：prod 48 + qa 48 + 各类 addon 29 + ops 4。
- **AppProject 13 个**；入口 `init-*` Application 5 个。
- 目标集群：prod 5 个目标名（同一物理集群在不同 appset 里可能有别名，写文章时统一口径）、qa 2 个；全仓库 list generator 里共出现 14 个不同名字。
- 生产镜像 tag 约定：`prod_<sha7>`（约 41/45），个别用语义化版本 `prod_vX.Y.Z`。

### 6.2 generator 使用分布（第 4 篇核心素材）

| generator | 数量 | 用在哪 |
|---|---|---|
| list | 120 | 所有业务服务；集群手写在 appset 里 |
| git（directories） | 7 | 按集群差异化的 addon：cilium、cilium-gateway、envoy-gateway、karpenter、kube-proxy-patch、vault-integration、redisinsight |
| clusters | 2 | 公共组件（common）、prometheus-adapter（只选 `env=prod`） |

**可写的对比**：
- 业务服务为什么坚持 list（直观、可 diff、每个集群 valueFile 显式指定）。
- addon 为什么改用 git directories（目录名即集群名，新增集群 = 新增一个目录）。
- clusters generator 的玩法：在 ArgoCD 的集群 Secret 上打 `env` 标签，仓库里不写死集群列表。

### 6.3 三个值得单独讲的 appset

1. **业务服务的典型 appset**（list，3 集群）：fasttemplate 语法（`{{name}}`、`{{cluster}}`、`{{valueFile}}`）；`image.tag`、`ticket` 通过 helm parameters 注入，**而不是写在 values 文件里**。这是发布流水线能“只改一行”的关键，也是第 5 篇的前置。
2. **Karpenter**（git directories + 三个 source + `ref: values`）：上游 chart + 共享 values + 每集群 values + 本地 chart（NodePool 模板）。共享 vs 环境差异的字段分组在 openspec 里有规范。可与已发布的 `run-karpenter-on-oke-with-argocd.md` 呼应。
3. **cilium-gateway**（git directories，三个 source）：Gateway API CRD 作为第一个 source、本地 chart 渲染 Gateway 实例、`ref: values` 提供集群差异；使用 ServerSideApply。

### 6.4 同步策略与 syncOptions（第 6 篇素材）

| 项 | 统计 |
|---|---|
| prune/selfHeal 全关 | prod 32、qa 30、addon 3、ops 3 |
| prune/selfHeal 全开 | prod 16、qa 18、addon 25、ops 1 |
| `ApplyOutOfSyncOnly` | prod/qa 全部 |
| `RespectIgnoreDifferences` | prod/qa 全部 |
| `ServerSideApply` | 仅 addon（10 个），prod/qa 为 0 |
| `Force=true` | 仅 kube-proxy-patch（与 SSA 同用） |
| `ignoreDifferences` 忽略 `/spec/replicas` | 95 个 appset 一字不差地重复同一段（Deployment + Rollout） |
| `retry` | 仅 1 个 appset 配置 |

**第 6 篇的写法（作者决定：不追究本环境为什么这样设置，只讲清概念 + 给实际案例）**：

- **目标**：把 `automated`、`prune`、`selfHeal` 三者讲清楚，尤其是“开自动同步 ≠ 开 prune / selfHeal”。
  - `automated`：Git 变了就自动 sync。
  - `prune`：Git 里删掉的资源，集群里也跟着删。
  - `selfHeal`：集群被手动改了，自动改回 Git 的样子。
- **本环境的事实（只陈述现状，不解释原因）**：
  - 业务 appset：`automated` 都在，prod 32 个 `prune/selfHeal` 全关、16 个全开；全关的集中在 dsp / box / adx / website 等业务线，全开的主要是 data 管道类与 ds 策略类。
  - addon：29 个里 25 个全开。
  - 入口 `init-*` Application：只开 `selfHeal`，不开 `prune`。
- **实际案例候选**（真实 vs 示意分开标注，发布前核对脱敏）：
  1. **selfHeal 与“别的控制器改副本数”的冲突（机制真实，具体触发点待验证）**：别的控制器改了副本数，selfHeal 会把它改回 Git 里的值；业务 appset 因此都配了忽略 `/spec/replicas` 的 `ignoreDifferences`，并开 `RespectIgnoreDifferences`。注意：多数 chart 在开启 HPA 时本身就不渲染 `replicas`，更可能触发冲突的是 Rollout 的 `workloadRef` 会缩放被引用的 Deployment（推断，写前在 ArgoCD 里验证）。可按“chart 不渲染 replicas → `ignoreDifferences` 兜底 → Rollouts 接管”三层来讲，并配 HPA 的扩缩容参数一起讲。
  2. **prune 的两面（示意）**：好处是 Git 删除即下线，不留孤儿资源；风险是改名、拆分文件、误删 YAML 时会连带删除线上资源。可举“重命名一个 Deployment 的 values”这类常见操作。
  3. **入口 Application 只开 selfHeal 不开 prune（真实现状，效果说明）**：不开 prune 意味着删掉某个 appset 文件，不会级联删掉它管理的服务，需要人工确认；这是“效果”，不是作者当时的决策理由，写的时候别说成动机。
  4. **升级窗口临时关闭 prune（示意）**：做会改 API 版本或资源名的升级（如 CRD、apiVersion 迁移）时，先关 prune 再升级，最后恢复；可用 ExternalSecret `v1beta1 → v1` 作为讲解例子，但**不要说成本环境当时的做法**。
  5. **ApplyOutOfSyncOnly（真实）**：prod/qa 全部开启，只对有差异的资源 apply，减少大 appset 的同步压力。
- **主体结构：什么时候关、什么时候不用关**（依据 ArgoCD 机制整理，未联网核实，发布前对照官方文档核对）：
  - **先分清风险性质**：`prune` 是“删除”风险（可能不可逆）；`selfHeal` 是“覆盖”风险（可能与别的控制器抢着改）。两个开关分开判断，不必同开同关。
  - **prune 建议关**：
    - 有状态或删了难恢复的资源（PVC/PV、数据库 CR、Namespace、Secret/ExternalSecret）；Git revert 能恢复资源定义，恢复不了数据。
    - Git 结构经常重构（重命名资源、拆 chart、改 label selector）：旧名字会被当成“已删除”，连带删掉线上资源再重建，中间有中断。
    - 升级窗口（apiVersion、CRD 大版本、chart 大版本）：先关再升，升完恢复。
    - App-of-Apps 入口 Application：prune 会级联删除子 Application，进而删掉它管的全部服务。
  - **prune 不用关**：无状态、可重建、改动稳定的资源（Deployment、Service、ConfigMap）；qa 等希望保持干净、不留孤儿资源的环境；模板稳定生成、很少重命名的基础组件。
  - **selfHeal 建议关**：
    - 别的控制器也在改同一字段又没配 `ignoreDifferences`（HPA 改 `replicas`、Rollouts 改 HTTPRoute 流量权重、mutating webhook 注入字段），会“同步打架”。
    - 需要线上应急手改（紧急扩容、临时改环境变量、`kubectl edit` 排障），selfHeal 会很快改回去。
  - **selfHeal 不用关**：资源没有其他控制器改它；环境要求“禁止手改，一切以 Git 为准”，需要自动纠偏；基础组件（addon 类）。
  - **四条经验**：
    1. 先想 `ignoreDifferences`，再想关 selfHeal；与 HPA、Rollouts 打架通常忽略那几个字段即可，不必整个关。
    2. prune 可以保护单个资源：注解 `argocd.argoproj.io/sync-options: Prune=false`，其余资源照常开 prune，比整个 appset 关闭更细。
    3. 想完全人工控制，就去掉 `automated`：ArgoCD 只检测、不自动同步，与“关 prune/selfHeal”是两种不同强度。
    4. 临时关的要有恢复动作：升级前关、升完立刻恢复，并在提交信息里写原因，避免“临时开关”变成永久默认。
  - 案例 1（HPA）对应“selfHeal 建议关”的第一条；案例 4（升级窗口）对应“prune 建议关”的第三条；案例 3（入口 Application）对应第四条。
- **不写**：各 appset 具体何时、为何被关；git 历史里的提交考证。

**可写的点**：
- 为什么业务 appset 不开 SSA，而 addon（CRD 多、体积大）要开。
- 入口 Application 全部只开 `selfHeal`、不开 `prune`。

### 6.5 AppProject（第 9 篇素材）

- 13 个 Project，按“环境 × 业务线”切分（prod-/qa- 加 业务线）。
- **所有 Project** 的资源白名单都是 `*/*`，`sourceRepos` 都是 `*`，没有 roles、syncWindows、orphanedResources；差异只在 destinations。
- 第 9 篇讲推荐的 Project 划分：按“环境 × 业务线”切；用 `destinations` 限定目标集群与命名空间；用 RBAC 角色限定谁能操作哪个 Project（SSO 与角色的示例见 7.6）。

### 6.6 入口与目录约定（第 2 篇素材）

- 5 个 `init-*` 入口都只开 `selfHeal`；**只有 oke-addon 入口开启 `directory.recurse`**，所以 addon 可以按子目录组织，而业务 appset 是平铺的。
- 业务 appset 用 fasttemplate；oke-addon 里 8 个文件使用 `goTemplate: true` + `missingkey=error`，可以讲“新旧写法并存”。

### 6.7 ops 与 addon（第 1 篇的背景）

- ops 集群除 ArgoCD 外还跑：Argo Workflows / Argo Events（发布流水线）、Atlantis（Terraform PR 自动化）、MinIO（Argo 制品存储）、Grafana MCP（只读）、Kafka UI / Exporter、Consul 备份、Redis 集群、prometheus-adapter（基于业务 QPS 的外部指标，给 HPA 用）。
- addon 覆盖：cilium、cilium-gateway、envoy-gateway、karpenter、external-secrets、external-dns、ingress-nginx（6 个实例）、vault 与 vault-integration、alloy / loki / prometheus、argo-rollouts、cert-manager-webhook、kube-proxy-patch、nodelocaldns、strimzi 等。

### 6.8 已用到的进阶特性（可作示例）

- multi-source + `ref: values`、goTemplate、sourceNamespaces、ServerSideApply、retry。
- 其他渠道已跑通的进阶用法（如 sync waves、hooks、Notifications）按“推荐做法”直接讲，不需要仓库里有对应代码，也不必说明“我们这里没用”。

### 6.9 openspec 变更管理

- 仓库里有 2 个 change：给 inference-web 做专属 Karpenter 节点池（解决 CPU:内存比例与共享池不匹配的装箱浪费）；抽象 NodePool / OCINodeClass 的共享模板与字段分组规范。
- 可以讲“用 spec 驱动基础设施变更”如何与 GitOps 配合。

## 7. 素材库 B：chart 仓库（已脱敏）

### 7.1 通用 chart 的能力与设计点（第 3 篇核心素材）

**开关与默认值**

| 能力 | 开关 | 默认 |
|---|---|---|
| Ingress | `ingress.enabled` | 关 |
| Gateway API 路由 | `httpRoute.enabled` | 关 |
| 金丝雀 | `canary.enabled`（`trafficRouting`: nginx 或 gateway） | 关，默认走 nginx |
| HPA | `autoscaling.enabled` | **开**，2–100 副本 |
| 密钥 | `vault.keys`（列表） | 空 |

**HPA 的设计（可单独成段）**：同时用一个外部指标（业务 QPS，来自 prometheus-adapter）和 CPU 60%；扩容快、缩容慢——扩容每 60 秒最多加 30%，缩容每 900 秒最多减 5%，并带 900 秒稳定窗口。`ignoreDifferences` 忽略 `replicas` 正是为了配合它。

**模板里的有意思的点**

- `Deployment` **始终渲染**；开启金丝雀时，`Rollout` 通过 `workloadRef` 引用这个 Deployment，不重复定义 Pod 模板，`scaleDown: onsuccess`。好处：开关金丝雀不改 Deployment。
- HPA 的目标会随金丝雀开关切换：开启时指向 `Rollout`，否则指向 `Deployment`。
- 金丝雀会多渲染一个 `-canary` 的 Service；Gateway 模式下 `HTTPRoute` 的 backendRefs 是 stable 100 / canary 0，由 Rollouts 的 Gateway API 插件改写权重；nginx 模式则由 Rollouts 基于 stableIngress 自动生成 canary Ingress。
- `ExternalSecret` 对 `vault.keys` 的每一项做 `extract`，多个 Vault 路径合并成同一个 K8s Secret，再通过 `envFrom` 注入。这是“全局 + 区域”两层密钥的实现方式。
- 镜像 tag 在 values 里是占位符，由 ApplicationSet 的 helm parameters 覆盖。
- 命名规则：release 名已包含 chart 名则直接用，否则 `<release>-<chart>`，截断 63 字符。
- 节点调度默认容忍抢占式节点，并偏好抢占式节点（成本）；反亲和性做了软约束。

### 7.2 复用的现实：从“通用”到“分叉”（第 3 篇的主线）

| 业务目录 | 不同集群/环境的 values 文件数 | chart |
|---|---|---|
| 最早的业务（dsp） | 8 | 直接使用通用 chart |
| 其他服务目录 | 28 / 16 / 17 | 各自分叉出 chart |
| 数据与报表类 | 11 / 8 | 各自独立 chart |
| 策略/决策类 | 12 | 5 个独立 chart |
| 前后端 dashboard 类 | 6–17 | 各自独立 chart |

- 分叉版本之间已有差异，例如有的没有 Rollout 模板，有的多了一个 Cilium Envoy 配置模板。
- **核实（2026-11 对照仓库）**：helm 仓库共 68 个 chart，prod 的 48 个业务 appset 实际引用约 26 个不同 chart 路径。业务 chart 基本是通用 chart（`dsp/dsp`）的**裁剪副本**：`deployment.yaml` 差异仅 6–44 行（通用版 75 行）；`hpa.yaml` 多数是 32–36 行的简化版（通用版 84 行，含 QPS 指标 + CPU + 扩缩容行为）；模板文件比通用版少 2–5 个。**只有 `dsp/dsp` 与 `inference-web` 两个 chart 带 Rollout 模板**，金丝雀能力只在这两处。dsp-services-bid 用 `dsp/dsp`，其余 6 个 dsp 服务用自己的副本。分叉是“裁剪骨架”，不是各自长出新功能。
- **现状（短平快）**：chart 放在独立的 helm 仓库；prod 的 48 个业务 appset，chart 来源的 `targetRevision` **全部是 `dev` 分支**，即跟随 dev 最新提交，chart 版本没有固定；镜像 tag 固定（`prod_<sha7>`），chart 不固定。（仅作背景，文章里一笔带过，不展开成缺陷。）

### 7.2.1 第 3 篇的写法：以目标形态为结论（作者决定）

**作者原话要点**：服务小，所以 chart 暂时独立成一个仓库；实际上 chart 应该与项目放在一起，成为代码的一部分，chart 的变动也应视为上线；生产发版要打 tag，按 tag 生成镜像，ArgoCD 用 tag 名找到对应的 chart，tag 不可变，别人改不了；至于分叉，只要开发人员自己能接受由此带来的不便就可以。

**读者要拿走的结论**：
- chart 与应用代码同仓，随代码一起评审、一起版本化。
- chart 变动 = 上线，走与代码相同的发布流程。
- 生产发版 = 打 tag → 按 tag 构建镜像 → ArgoCD 的 `targetRevision` 指向同一个 tag 下的 chart；tag 不可变，发布内容可复现、可回滚、可审计。
- 通用 chart 与分叉：不强求统一，由团队自己权衡维护成本，能接受就行。

**行文结构建议**：
1. 先给结论与理由（为什么 chart 要随代码、为什么要 tag 不可变）。
2. 现状一笔带过（遵循第 5 节原则）：用一两句说明“我们的 chart 目前放在独立仓库，这里讲的是我认为更正确的做法”，不展开成缺陷清单。
3. 补充：开关式通用 chart 的设计、每集群一个 values 文件、分叉的做法（裁剪式分叉：开发人员能接受同步成本时，让各业务线独立演进）。
4. 与第 5 篇衔接：发布流水线现在只改 `image.tag`；目标形态下需要同时固定 chart 的 tag，可预告。

**写作注意**：
- 现状与目标要分清，不要把目标形态写成“我们已经这样做了”。
- 技术细节（`targetRevision` 指向 tag、tag 保护规则）发布前对照 ArgoCD 与 GitHub 文档核对。
- 现状里的 `dev` 分支等细节脱敏后写成“跟随主干分支”。

### 7.3 同一服务在不同集群的 values 差异（第 3、4 篇素材）

以同一个服务的 3 个生产集群为例，差异集中在：

- **副本数**：4 / 2 / 1（按集群流量）。
- **域名与 external-dns 注解**：按区域各一个；部分带 set-identifier（多集群同名解析）。
- **Vault keys**：都包含一个公共路径，再按区域追加一个区域路径。
- **autoscaling**：部分集群关闭 HPA，用固定副本。
- **金丝雀**：三个都开，steps 相同。
- 文件命名规则并不严格统一（有的带区域前缀，有的带序号后缀）。
- **迁移叙事**：较新的集群不再用 Ingress，而是用 `httpRoute` 挂到 Cilium Gateway，并且金丝雀的流量切分也改用 Gateway 模式。其余集群仍是 nginx。可以写成“从 ingress-nginx 到 Gateway API 的渐进迁移”。

### 7.4 Rollouts（第 8 篇素材）

- steps：`1% → pause → 10% → pause → 50% → pause`，**pause 不设时长，每一步都要人工 promote**。
- Rollouts controller：2 副本 + PDB（minAvailable 1）；Gateway API 插件固定了版本；所有 provider 的 RBAC 都开启。
- ArgoCD 的 RBAC 里，各业务线的生产角色被授予 Rollout 的 `promote-full` 与 `resume` 动作，与“人工 promote”对应——这是 **Rollouts 与 ArgoCD RBAC 的衔接点**，很少有文章讲。

### 7.5 Secret 与证书（第 7 篇素材）

- ClusterSecretStore 按环境命名（infra / prod / qa），**用 Kubernetes auth 连接 Vault，没有静态 token**；每个集群在 Vault 里启用独立的 auth 挂载点。
- `ClusterExternalSecret`：把镜像仓库凭据分发到带特定标签的所有 namespace（刷新 1 小时）。
- 证书：cert-manager 用 DNS-01（通过各 DNS 提供商的 webhook）签发泛域名证书，再用 reflector 把证书 Secret 镜像到需要的 namespace。
- Vault 自身也由 chart 部署（HA + Consul 存储）；仓库里有初始化、unseal、AppRole、各集群 auth 的运维 README。

### 7.6 ArgoCD 自身的定制（第 1、9 篇素材）

**部署形态**

- wrapper chart；controller / server / applicationSet controller / repo-server **各 2 副本**；server 与 repo-server 开了 HPA（CPU、内存 70%）。
- controller 的 `status.processors` 30、`operation.processors` 50（上游默认更小）。
- server 用 `insecure` 模式，TLS 在 Ingress 终止；证书由 cert-manager 签发。
- 开启 `allowAnyNamespace` 与 `application.namespaces`，对应 Project 里的 `sourceNamespaces`。
- 安装了 rollout-extension（在 ArgoCD UI 里直接看 Rollout）。
- 所有组件开启了 metrics 与 ServiceMonitor。

**SSO 与权限（第 9 篇主线）**

- 通过 dex 接入 GitHub SSO，按 GitHub 团队映射角色。
- 角色：管理员；开发者（只能操作 qa 的 Project）；按业务线划分的生产角色（只能操作自己业务线的 Project）。
- 一个值得写的细节：webhook/回调入口单独暴露了一个外部 Ingress，限制来源 IP、限速，并加了安全响应头。

### 7.7 发布流水线全链路（第 5 篇主线）

```
GitHub 事件 → Argo Events（EventSource + Sensor）
  PR 打开/更新 → 构建镜像（tag 前缀 qa_）
  合并到 main  → 构建镜像（tag 前缀 prod_）
→ 镜像构建模板（amd64 + arm64，推送镜像仓库，tag = 前缀_短 commit）
→ 通用部署模板：改 apps 仓库里对应 appset 的 image.tag，开分支、提 PR、开启自动合并
→ ArgoCD 检测到 apps 仓库变化并同步
→ （开启金丝雀的服务）Rollouts 按 steps 逐步放量，等待人工 promote
```

- **PR 免人工 review 与回滚（作者确认）**：流程已定义好，所以自动合并不需要人审，靠快速回滚兜底。此前的发布方式是 **Jira ticket 触发 deploy**，ticket 里写明**新版本号和回滚版本号**，可在 Jira 上自助操作回滚；appset 里的 `ticket` 参数正是这条链路的延续。
  - **回滚走同一条流水线（作者确认）**：把 `image.tag` 改回回滚版本号，再提 PR 自动合并，与正常发布完全同一条路径，没有单独的回滚通道。好处是回滚也有 PR 记录、同样带 `ticket`，操作路径只有一条。
  - 待确认：“此前”具体指哪个阶段/环境，写文章时要说清。
  - 文章角度：PR 在这里是**审计记录**而不是**审批关卡**；“敢不审”的依据是回滚路径明确、人人可操作。
- 通用部署模板：根据 `deployment-mapping.yaml` 找到 appset 文件；**若当前 tag 与新 tag 相同则直接跳过**（防止空提交）；分支名由“服务名 + tag”确定；整个步骤失败自动重试 3 次（指数退避）。
- 工作流模板共 90 个，按业务线分目录；`workflow-autogen` 用 gomplate 根据 vars 文件批量生成各服务的模板，改完 vars 要手动 `make` 并提交生成物。
- 文章角度：为什么自研而不是用 Image Updater？
  - **作者给出的核心理由**：整套设计沿用了 Jenkins 的“流式结构”（构建 → 部署 → 验证，线性流水线、发布是一个有起终点的事件），同时兼顾 GitOps 标准——部署动作不是流水线直接 apply，而是把期望状态写回 Git（PR），再由 ArgoCD 拉取同步。
  - **文章主线**：“推式流水线 vs 拉式 GitOps 的折中”。Image Updater 是纯 GitOps 思路（无发布事件，只有状态收敛）；这里保留发布事件的概念，团队从 Jenkins 迁移几乎没有认知成本，同时 Git 仍是唯一真相。
  - **好处**：每次发布都有明确触发、PR 记录、工单关联（`ticket` 参数）；事件驱动而非轮询。
  - **适用边界（一句话带过即可）**：多一层要维护（mapping 文件、工作流模板）；“发布完成”分成 PR 合并与 ArgoCD 同步完成两段。
  - **辅助对比点（推断，写前需核实 Image Updater 当前版本）**：tag 为 `prod_<sha7>`，semver 策略用不上；Image Updater 的 git write-back 默认直接提交而不开 PR；按 Application 注解配置，与 ApplicationSet 模板配合较别扭。

### 7.8 日常变更长什么样（第 1 篇或第 10 篇素材）

- chart 仓库约 1800 次提交，跨度两年多。
- 最近 30 条里，**绝大多数是 values 调参**：HPA 的 QPS 阈值、内存、CPU、金丝雀比例。
- 偶尔有结构性变更（如把一个集群的 HPA/资源对齐到另一个集群）、回滚、以及标注“尚未生效”的前置提交。
- 最常被改的文件，除了各服务的 values，就是镜像构建的 workflow 模板。
- 可以写成：“GitOps 落地之后，日常运维 = 改 values 的 PR”。

## 8. 待确认

- [x] 全开 / 全关：第 6 篇只讲概念 + 案例，不追究本环境为何这样设置（见 6.4）。
- [x] 回滚走同一条流水线（改回 tag + 提 PR），作者已确认（见 7.7）。
- [ ] 确认“此前 Jira ticket 流程”的所指（写第 5 篇前）。
- [ ] 发布前对照官方文档核实：第 6 篇“何时关 prune / selfHeal”的论述、第 5 篇对 Image Updater 的对比、第 3 篇 `targetRevision` 指向 tag 的做法。

## 9. TODO（接力用）

- [x] 补充 apps 仓库素材（第 6 节）。
- [x] 补充 chart 仓库素材（第 7 节）。
- [x] 作者已补充：为什么自研发布流水线而不是 Image Updater（见 7.7，沿用 Jenkins 流式结构 + 兼顾 GitOps）。
- [x] 作者已补充：PR 无需人工 review，靠 Jira ticket 的回滚版本号快速回滚（见 7.7）。
- [ ] 作者确认提纲顺序与取舍（v2）。
- [ ] 起草第 1 篇。
- [ ] 为每篇准备架构图 / 时序图（可用 archify 生成）。
- [ ] 发布前通读一遍，核对脱敏。
