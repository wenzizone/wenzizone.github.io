---
title: 玩转 ArgoCD 系列提纲（工作文档，不发布）
date: 2026-11-05 10:00:00
tags: [argocd, gitops, kubernetes]
categories: Devops
---

> 这是系列写作的**工作文档**，不是文章。换电脑后先读本文，再继续。
> 状态：提纲 v1；两个仓库的真实素材都已补入（第 6、7 节）；待作者补充几处“为什么”（见文末 TODO），然后起草第 1 篇。

## 1. 定位与写法

- **语言**：中文。
- **读者**：新手与老手兼顾。每篇前半给新手（概念 + 最小示例），后半讲“我在生产里是怎么做的”。每篇开头加一行导读，例如“新手读 1–3 节，有经验的直接看第 4 节起”。
- **风格**：以自己的真实实践为主线，不写空泛介绍。每个关键决策用固定小模板：**我的做法 → 备选方案 → 为什么没选 → 这个做法的代价**。
- **系列形式**：参照已有的 Strimzi 系列（`strimzi-what-and-why.md`）：第一篇交代全系列脉络，最后一篇回到自己的环境复盘。
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
  CI 构建镜像 → Argo Workflows 的通用部署模板 → 查 `deployment-mapping.yaml` 定位 appset → `yq` 修改 `image.tag` → 开分支、自动提 PR 并**开启自动合并**（`gh pr merge --auto`，是否需要人工 review 取决于分支保护规则，待作者确认）→ ArgoCD 同步。appset 里还带 `ticket` 参数，把发布与工单关联。
- **同步策略并非一刀切**：生产 48 个 appset 中，32 个 `prune/selfHeal` 全关，16 个全开；qa 是 30 关 / 18 开。addon 类 29 个 appset 里 25 个全开。全开与全关各自对应哪类服务、为什么这么分，**需要作者补充理由**（第 6 篇的核心）。所有业务 appset 都忽略 `replicas`（给 HPA 让路），并统一启用 `ApplyOutOfSyncOnly`、`RespectIgnoreDifferences`。
- **Secret**：external-secrets 从 Vault 同步，按环境选 ClusterSecretStore，`refreshInterval` 为 10s；Secret 不进 Git。
- **渐进式发布**：通用 chart 里 `canary.enabled` 开关；Rollout 用 `workloadRef` 引用已有 Deployment；支持 Gateway API 或 nginx 做流量切分；steps 为 1% → 10% → 50%，每步手动 pause。**仅个别服务启用**。
- **变更管理**：apps 仓库里用 openspec 管理较大的变更。
- **体感**：目前使用顺利，没有印象深刻的故障案例。

## 4. 提纲（v1）

| # | 主题 | 新手层 | 实践层（真实素材来源） |
|---|---|---|---|
| 1 | 全景：我们的 ArgoCD 如何管多个集群 | GitOps 是什么；ArgoCD 架构 | 单控制面管多集群的整体图；两个仓库分工；一次发布的完整旅程概览 |
| 2 | App-of-Apps：入口 Application + 每服务一个 ApplicationSet | Application / ApplicationSet 概念 | `init-*` 入口；目录结构；新增一个服务要改哪些文件 |
| 3 | 通用 Helm Chart 的设计与演进 | Helm values 分层 | 开关式设计；每集群一个 values 的差异点；为什么后来各业务线分叉出自己的 chart（取舍与代价） |
| 4 | 多集群多区域：list generator 怎么表达 | generator 种类对比 | 一个 appset 覆盖多个集群；为什么用 list 而不是 cluster/matrix |
| 5 | 发布流水线：Argo Workflows 自动提 PR 改 image.tag | Argo Events / Workflows 简介 | 通用部署模板全流程；mapping 文件；为什么走 PR 而不是 Image Updater |
| 6 | 生产同步策略：为什么 prune / selfHeal 都关 | 同步策略各选项含义 | `ignoreDifferences` 与 HPA；各 syncOptions 的取舍 |
| 7 | Secret：External Secrets + Vault | Secret 不进 Git 的几种方案对比 | ExternalSecret 写法；ClusterSecretStore；10s 刷新的取舍 |
| 8 | Argo Rollouts：workloadRef + 金丝雀 | 金丝雀 vs 蓝绿 | chart 里 canary 开关；Gateway API 流量切分；为什么只给个别服务上 |
| 9 | AppProject 与权限划分 | Project / RBAC 概念 | 业务线 × 环境的 Project 切分；白名单的取舍 |
| 10 | 复盘：为什么顺利、风险与下一步 | — | 单控制面的风险与兜底；mapping 手工维护；Project 白名单偏宽 |

建议先写 **1、2、3**，连起来是完整的“仓库设计”主题；第 1 篇最有故事线，从一个 PR 的诞生讲到 Pod 滚动。

## 5. 复盘篇（第 10 篇）可用的观察

这些是读仓库时发现的、适合当作“不足与下一步”来写的点，是否公开由作者决定：

- `deployment-mapping.yaml` 为手工维护，新增服务要同时改 appset 与 mapping 两处。
- mapping 中个别条目的 key 与 appfile 文件名不对应，需要核对。
- AppProject 的 `sourceRepos` 与资源白名单为 `*`，权限边界偏宽。
- 单套 ArgoCD 管全部集群，存在单点与爆炸半径问题。
- 通用 chart 分叉后，改一处要在多个 chart 里同步；分叉版本之间已出现功能差异（有的带 Rollout 模板，有的没有）。
- ArgoCD 的 wrapper chart 声明依赖版本与仓库里打包的依赖版本不一致，实际渲染取决于是否执行过依赖更新。
- 通用 chart 里有个默认值写死了某个服务的实例名（反亲和性），换服务时容易漏改。

## 6. 素材库 A：apps 仓库（已脱敏）

### 6.1 规模数字（可放进第 1 篇开头）

- 全仓库约 210 个 yaml，其中 **ApplicationSet 129 个**：prod 48 + qa 48 + 各类 addon 29 + ops 4。
- **AppProject 13 个**；入口 `init-*` Application 5 个。
- 目标集群：prod 5 个目标名（同一物理集群在不同 appset 里可能有别名，写文章时统一口径）、qa 2 个；全仓库 list generator 里共出现 14 个不同名字。
- 生产镜像 tag 约定：`prod_<sha7>`（约 41/45），个别用语义化版本 `prod_vX.Y.Z`；有 2 个 prod 服务仍在用 `qa_<sha7>`，可作为“约定靠人守”的例子。

### 6.2 generator 使用分布（第 4 篇核心素材）

| generator | 数量 | 用在哪 |
|---|---|---|
| list | 120 | 所有业务服务；集群手写在 appset 里 |
| git（directories） | 7 | 按集群差异化的 addon：cilium、cilium-gateway、envoy-gateway、karpenter、kube-proxy-patch、vault-integration、redisinsight |
| clusters | 2 | 公共组件（common）、prometheus-adapter（只选 `env=prod`） |
| matrix / merge / pullRequest | 0 | 未使用 |

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

**可写的点**：
- 为什么业务 appset 不开 SSA，而 addon（CRD 多、体积大）要开。
- 95 处重复的 `ignoreDifferences` 是一个“模板化 YAML 的代价”，复盘篇可以聊怎么收敛。
- 入口 Application 全部只开 `selfHeal`、不开 `prune`。

### 6.5 AppProject（第 9 篇素材）

- 13 个 Project，按“环境 × 业务线”切分（prod-/qa- 加 业务线）。
- **所有 Project** 的资源白名单都是 `*/*`，`sourceRepos` 都是 `*`，没有 roles、syncWindows、orphanedResources；差异只在 destinations。
- 这意味着当前 Project 的作用主要是“目标集群与命名空间的边界 + UI 分组”，而不是权限隔离。可作为“现状与下一步”如实写。

### 6.6 入口与目录约定（第 2 篇素材）

- 5 个 `init-*` 入口都只开 `selfHeal`；**只有 oke-addon 入口开启 `directory.recurse`**，所以 addon 可以按子目录组织，而业务 appset 是平铺的。
- 业务 appset 用 fasttemplate；oke-addon 里 8 个文件使用 `goTemplate: true` + `missingkey=error`，可以讲“新旧写法并存”。
- 一个异常点：qa 里有 1 个 Application 不走标准的 apps/chart 两个仓库，也不在 mapping 里（试验性质）。

### 6.7 ops 与 addon（第 1、10 篇的背景）

- ops 集群除 ArgoCD 外还跑：Argo Workflows / Argo Events（发布流水线）、Atlantis（Terraform PR 自动化）、MinIO（Argo 制品存储）、Grafana MCP（只读）、Kafka UI / Exporter、Consul 备份、Redis 集群、prometheus-adapter（基于业务 QPS 的外部指标，给 HPA 用）。
- addon 覆盖：cilium、cilium-gateway、envoy-gateway、karpenter、external-secrets、external-dns、ingress-nginx（6 个实例）、vault 与 vault-integration、alloy / loki / prometheus、argo-rollouts、cert-manager-webhook、kube-proxy-patch、nodelocaldns、strimzi 等。

### 6.8 进阶特性使用情况（诚实地写“没用到的”）

- **未使用**：sync waves、resource hooks、Notifications、resource tracking 注解、progressive sync（RollingSync）、syncWindows、matrix/merge generator。
- **已使用**：multi-source + `ref: values`、goTemplate、sourceNamespaces、ServerSideApply、retry（仅 1 处）。
- 复盘篇可以把“没用到的”写成“为什么暂时不需要 / 下一步可能引入”。

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

**可作为“代价”来写的小坑**：默认值里有一处反亲和性硬编码了某个服务的实例名；ExternalSecret 没有 `if` 守卫（所有服务都会渲染）；`refreshInterval` 为 10 秒，而仓库里其他地方常用 1 小时。

### 7.2 复用的现实：从“通用”到“分叉”（第 3 篇的主线）

| 业务目录 | 不同集群/环境的 values 文件数 | chart |
|---|---|---|
| 最早的业务（dsp） | 8 | 直接使用通用 chart |
| 其他服务目录 | 28 / 16 / 17 | 各自分叉出 chart |
| 数据与报表类 | 11 / 8 | 各自独立 chart |
| 策略/决策类 | 12 | 5 个独立 chart |
| 前后端 dashboard 类 | 6–17 | 各自独立 chart |

- 分叉版本之间已有差异，例如有的没有 Rollout 模板，有的多了一个 Cilium Envoy 配置模板。
- 文章角度：为什么没有做成 library chart / 子 chart 依赖？分叉让每个业务线可以独立演进，代价是改通用逻辑要多处同步。这比“一个 chart 打天下”更真实，也更有讨论价值。

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
- 没有使用 AnalysisTemplate（自动分析与回滚）。
- Rollouts controller：2 副本 + PDB（minAvailable 1）；Gateway API 插件固定了版本；所有 provider 的 RBAC 都开启。
- ArgoCD 的 RBAC 里，各业务线的生产角色被授予 Rollout 的 `promote-full` 与 `resume` 动作，与“人工 promote”对应——这是 **Rollouts 与 ArgoCD RBAC 的衔接点**，很少有文章讲。

### 7.5 Secret 与证书（第 7 篇素材）

- ClusterSecretStore 按环境命名（infra / prod / qa），**用 Kubernetes auth 连接 Vault，没有静态 token**；每个集群在 Vault 里启用独立的 auth 挂载点。
- `ClusterExternalSecret`：把镜像仓库凭据分发到带特定标签的所有 namespace（刷新 1 小时）。
- 证书：cert-manager 用 DNS-01（通过各 DNS 提供商的 webhook）签发泛域名证书，再用 reflector 把证书 Secret 镜像到需要的 namespace。
- Vault 自身也由 chart 部署（HA + Consul 存储）；仓库里有初始化、unseal、AppRole、各集群 auth 的运维 README。

### 7.6 ArgoCD 自身的定制（第 1、9、10 篇素材）

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

**没有做的定制（诚实地写）**：controller 分片、`timeout.reconciliation`、`resource.exclusions/customizations`、repo-server 缓存与 helm/kustomize 参数、Notifications 的具体配置、各组件的资源 requests/limits（全部用上游默认值）。

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

- 通用部署模板：根据 `deployment-mapping.yaml` 找到 appset 文件；**若当前 tag 与新 tag 相同则直接跳过**（防止空提交）；分支名由“服务名 + tag”确定；整个步骤失败自动重试 3 次（指数退避）。
- 工作流模板共 90 个，按业务线分目录；`workflow-autogen` 用 gomplate 根据 vars 文件批量生成各服务的模板，改完 vars 要手动 `make` 并提交生成物。
- 文章角度：为什么自研而不是用 Image Updater？（CI 已经有 Argo Workflows；需要 PR 作为变更记录；一个模板服务所有业务。具体理由请作者补充。）

### 7.8 日常变更长什么样（第 10 篇素材）

- chart 仓库约 1800 次提交，跨度两年多。
- 最近 30 条里，**绝大多数是 values 调参**：HPA 的 QPS 阈值、内存、CPU、金丝雀比例；约 4 成的提交信息只写 “update”。
- 偶尔有结构性变更（如把一个集群的 HPA/资源对齐到另一个集群）、回滚、以及标注“尚未生效”的前置提交。
- 最常被改的文件，除了各服务的 values，就是镜像构建的 workflow 模板。
- 可以写成：“GitOps 落地之后，日常运维 = 改 values 的 PR”，并反思提交信息质量。

## 8. 待核实 / 待决定（不一定都公开）

- [ ] **mapping 与文件不一致**（已核实）：qa 有 1 个 key 指向不存在的文件；prod 有 1 个 key 指向不存在的文件；qa、prod 各有约 4 个 appset 没有被 mapping 引用。第 10 篇可作为“手工维护的代价”。
- [ ] **Project 的 destinations 疑似不覆盖**：prod 的 data 业务线有一个 appset 的部分目标集群，未出现在对应 Project 的 destinations 里（按字符串精确匹配）。需要在 ArgoCD 里确认是否真的被拒绝同步，或另有生效的配置，**确认前不要写进文章**。
- [ ] 全开 / 全关的分组依据，请作者补充。

## 9. TODO（接力用）

- [x] 补充 apps 仓库素材（第 6 节）。
- [x] 补充 chart 仓库素材（第 7 节）。
- [ ] 作者补充理由：prune/selfHeal 全开 vs 全关的分组依据；为什么自研发布流水线而不是 Image Updater；PR 是否真的无需人工 review。
- [ ] 作者决定哪些“不足”公开（第 5 节）。
- [ ] 作者确认提纲顺序与取舍。
- [ ] 起草第 1 篇。
- [ ] 为每篇准备架构图 / 时序图（可用 archify 生成）。
- [ ] 发布前通读一遍，核对脱敏。
