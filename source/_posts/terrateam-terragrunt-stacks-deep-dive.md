---
title: 在 Terrateam 上跑通 Terragrunt Stacks：一次从「完全不行」到「能跑但不放心」的踩坑实录
date: 2026-08-31 10:00:00
tags: [terrateam, terragrunt, ci-cd]
categories: Devops
cover: /images/terragrunt/terrateam-terragrunt-stacks-deep-dive.png
description: '一次真实的 Terrateam + Terragrunt Stacks CI 集成调试全过程:从官方 config_builder 的死路,到找到 tree_builder 这个冷门开关,再到五个连环坑,最终换来的只是一份"能用但不放心"的配置方案。'
---

**写在前面**:这不是一篇官方文档的转述,是一次真实的、边打边退边进的调试记录。结论会在文章的最后给出,但我更想把中间踩过的每一个坑原样写下来——因为这些坑大多数**没有任何文档提到**,靠的是直接读 Terrateam 的 OCaml 源码、盯着 GitHub Actions 的原始日志一行行抠、以及若干次"看起来应该好了但其实还没有"的假阳性。如果你也在搞 Terragrunt 单体仓库(monorepo)+ Terrateam,大概率会撞上这里面的某一个坑,希望能帮你少走几步。

![在 Terrateam 上跑通 Terragrunt Stacks：一次从「完全不行」到「能跑但不放心」的踩坑实录](/images/terragrunt/terrateam-terragrunt-stacks-deep-dive.png)

---

## TL;DR

- Terrateam **官方支持 Stack 的方式(`config_builder` 自带的 `terragrunt-config-builder` 脚本)是不管用的**——它压根不解析 `terragrunt.stack.hcl`。
- 官方文档承诺的 `dirs.create_if_missing` 字段,**在决定"这个目录算不算数"的那行判断逻辑里,确实没有被检查**——这是穷举全部源码 + 定位到具体判断函数后拿到的结论,不是猜测。但这不等于"这个字段从没在任何人的场景里生效过"(详见第二章、第三章的验证过程和澄清)。
- 真正能 work 的路径是另一个几乎没人提的独立开关——`tree_builder`。它能让 Terrateam 把"未提交进 git 但确实存在"的目录当成合法的 dirspace。
- 但就算找对了机制,中间还有至少 5 个非常隐蔽的坑,每一个都会让你以为"这条路走不通了"。
- 最终方案不需要碰 Terrateam 一行源码,纯配置 + 两个自己写的小脚本就能搞定——但代价是什么,文章最后会如实说清楚。

---

## 背景:为什么会走到这一步

我们在用 Terragrunt 管理一个 GCP + Terraform 的基础设施单体仓库,按照 Gruntwork 的参考架构分成了 `catalog/`(可复用的 module 和 unit)和 `live/`(真正部署的实例)。CI/CD 用的是 Terrateam(不是 Atlantis,原因是并发模型更好)。

这套 catalog/live 的设计有一个已知的重复劳动问题:每新增一个环境实例,都要手写一个 `live/<service>/<env>/<instance>/terragrunt.hcl`,内容高度重复,只有 `inputs` 不一样。Terragrunt 1.x 引入的 **Stacks** 功能看起来正好能解决这个问题——用一个 `terragrunt.stack.hcl` 声明多个 `unit`,`terragrunt stack generate` 会自动把它们展开成一堆生成好的 `terragrunt.hcl`,不用手写重复文件。

问题是:**Terrateam 认不认这些生成出来的目录?**

这篇文章就是回答这个问题的全过程。

---

## 第一章:自带的 `config_builder` 脚本,一开始就是死路

Terrateam 有个叫 `config_builder` 的机制:在正常的 dirspace 发现流程**之前**,先跑一个脚本,脚本读当前的 repo config(JSON,通过 stdin),吐出补充/修改后的配置(通过 stdout),这个输出会被合并进最终生效的配置。听起来完美——理论上可以在这一步跑 `terragrunt stack generate`,把生成的目录注册成新的 dirspace。

Terrateam 官方自带了一个叫 `terragrunt-config-builder` 的脚本,配置很简单:

```yaml
config_builder:
  enabled: true
  script: terragrunt-config-builder
```

### 坑 1.1:自带脚本内部用了一个装错版本的 terragrunt

启用之后,build-config 这一步(config_builder 专属的、独立于 plan/apply 的一个 GitHub Actions job)日志里出现:

```
[WARN] No Terragrunt engine found; using Terragrunt 0.75.3 for discovery
...
Running terragrunt find --dependencies --format=json
ERROR flag provided but not defined: -dependencies
Running terragrunt list -l --dependencies
ERROR flag provided but not defined: -l
```

拆解一下这个坑的诡异之处:脚本内部调用的 `terragrunt find --dependencies`、`terragrunt list -l --dependencies` 都是 terragrunt **新版 CLI**(1.0 之后 CLI 重构引入)才有的子命令/参数。但脚本自己内部有个写死的兜底版本 `TG_DEFAULT_VERSION = '0.75.3'`——一个 CLI 重构**之前**的老版本,根本不认这些新参数。也就是说脚本自己跟自己打架:用新语法调用一个自己装的老版本。

修复方法是在 `.terrateam/config.yml` 里显式指定 engine 版本:

```yaml
workflows:
  - tag_query: ""
    engine:
      name: terragrunt
      version: "1.1.3"    # 加上这行
```

结果——**没用**。日志里依然是 "No Terragrunt engine found"。

### 坑 1.2:`workflows[].engine.version` 这个位置,脚本压根不读

后来直接去读 Terrateam 打包的那个脚本源码(`terrateamio/action` 仓库的 `bin/terragrunt-config-builder`,Python 写的)才找到真相:

```python
def get_terragrunt_engine(config):
    engine = config.get('engine')  # 先查顶层
    if not engine:
        # 再遍历 workflows —— 但这里假设 workflows 是一个 dict!
        for name, wf in config.get('workflows', {}).items():
            ...
```

而我们实际的 repo config JSON 里,`workflows` 是一个**数组**(每个 tag_query 匹配一条),不是字典:

```json
"workflows": [
  { "tag_query": "", "engine": {"name": "terragrunt", "version": "1.1.3"}, ... }
]
```

`{}.items()` 遇到 list 直接静默失败(或者说这段逻辑压根匹配不上),于是永远走"没找到 engine"的分支。

**真正有效的位置是顶层的 `engine:` 字段**,和 `workflows` 平级:

```yaml
engine:
  name: terragrunt
  version: "1.1.3"

config_builder:
  enabled: true
  script: terragrunt-config-builder
```

这样版本终于对了,`terragrunt find`/`list --dependencies` 也能正常跑通了。但——

### 坑 1.3:就算版本对了,自带脚本也根本不认识 `.stack.hcl`

版本问题解决之后,build-config 这一步终于顺利跑完,依赖图也正确生成了。但翻遍整个执行日志,**从头到尾没有一行提到 `terragrunt.stack.hcl` 这个文件**。脚本的逻辑就是扫描普通 `terragrunt.hcl` 文件、解析 `include`/`dependency` 块算依赖关系——跟 Stack 完全是两回事。它甚至把我们 `catalog/units/` 下面的可复用单元也当成独立 dirspace 报了出来,直接触发了我们专门配置过要抑制的一类 bug(见下一章)。

### 坑 1.4:自带脚本的输出,合并逻辑是无差别 union,不认识我们手写的抑制规则

去读 Terrateam 服务端源码(`terrat_vcs_service_github_provider.ml` 的 `fetch_with_provenance`)确认了合并语义:

```ocaml
merge ~base:built_config repo_config
```

`merge` 调的是 `Jsonu.merge`,对 JSON object(也就是 `dirs` 这种 key-value 结构)做的是**递归 key 级别的并集**——两边都有的 key 用覆盖方(手写 config.yml)的值,只有一边有的 key 原样保留。也就是说,自带脚本扫出来的每一个目录(包括我们专门用 `catalog/** -> __suppress__` 抑制掉的 catalog 单元、甚至跟这次改动完全无关的老环境 `environments/**`)全部会被当成全新的 `dirs` 条目加进最终配置——**代码里根本没有 `__suppress__` 这个概念**,那只是我们自己发明的一个字符串约定,Terrateam 从来没在代码里特殊处理过它。

结论:**自带的 `config_builder` 脚本,对我们这种 catalog/live 分离的仓库是净负分**——既不支持 Stack,还会把已经解决过的"catalog 单元被误判成独立 dirspace"问题重新引入。

到这里,第一轮尝试彻底失败,回滚。

---

## 第二章:自己写 config_builder 脚本,方向对了,但撞上了一个"写了但没人读"的字段

`config_builder.script` 字段本质上是"随便指一个可执行文件,Terrateam 会跑它、吃它吐出来的 JSON"——完全可以指向自己写的脚本,不一定要用官方那个。

### 方案:精确追踪 catalog 依赖

我们写了一个脚本:
1. 找到所有 `terragrunt.stack.hcl`
2. 跑 `terragrunt stack generate`
3. 对每个生成出来的 unit,**递归解析**它的 `terragrunt.hcl` 里 `source`/`path` 字段(可能是 `include` 到另一个 catalog unit,也可能是 `terraform.source` 指向一个 catalog module),一路追到底,拿到它真正依赖的全部 catalog 路径
4. 为每个生成的目录吐出一个精确的 `when_modified.file_patterns`,只包含它真正依赖的那几个 catalog 路径,而不是像现有 live/** 规则那样粗暴地写死整个 `catalog/**`

```python
def catalog_deps_for(terragrunt_hcl_path, seen=None):
    """递归追踪 include/source 引用,收集链路上所有 catalog 路径"""
    ...
```

本地测试完全正确:能精确解析出 `stack-test -> catalog/units/google-cloud-storage -> catalog/modules/google-cloud-storage` 这条两层依赖链。

配置也加上了防止漏报的关键字段:

```yaml
dirs:
  "infrastructure/terragrunt/live/.../.terragrunt-stack/bucket":
    create_if_missing: true    # 关键字段,文档说是干这个用的
    when_modified:
      file_patterns: [...]
```

`create_if_missing` 的官方文档(`dirs.mdx`)原话:

> This is useful when directories are dynamically generated, such as when using the config builder to register directories produced by tools like `terragrunt stack generate`.

——文档写得清清楚楚,就是为了我们这个场景设计的。

### 坑 2.1:`create_if_missing` 是个死字段

推上去之后,build-config 这一步完美运行:脚本正确生成了 stack、正确算出了依赖、把 JSON 通过 PUT 请求提交给了服务端,拿到 200 响应。但那个新目录**始终没有变成 PR 里的一个实际 check**——无论是自动触发还是手动评论 `terrateam plan` 都不出现。

**验证方法,写清楚免得这句话经不起较真**:直接 `grep -rn "create_if_missing" src/`,对 Terrateam 开源仓库整个 `src/` 目录做穷举搜索(不是只看某一个文件),完整命中列表是:

```
src/terrat_repo_config/terrat_repo_config_dir.ml:21:          create_if_missing : bool; [@default false]
src/terrat_base_repo_config_v1/terrat_base_repo_config_v1.ml:872,2287,2329,3052,3064
```

前者是字段的 schema 定义,后者全部是解析/序列化/透传代码(把这个字段从 YAML 读出来、再原样传到下一层配置结构里)。OCaml 里读取一个 record 字段,字段名必须原样出现在读取它的代码中,所以"全仓库只有这两个文件出现过这个字符串"基本可以确认:**没有第三个地方消费过这个字段**——包括我们本来最怀疑的匹配引擎 `terrat_change_match3.ml`,里面一次都没提到它。

这一步是纯静态的"没找到调用点"证据,还不是"找到了判断逻辑、逻辑里确实没有它"这种更强的证据(那一步是在下一章排查 `file_list` 来源时才顺带定位到的,见第三章)。但已经足够作为一个具体、可复现的 bug 提出去了。

带着这个发现去 GitHub 上提了 issue,维护者的回复很关键(也是这篇文章里最重要的一次"我以为我对了,其实我只对了一半"):

> I'm surprised to see this bug filed because I know existing users are using `dirs.create_if_missing`... I feel like there's more going on here.

这句话直接把我们送回了源码里,而且这次找对了地方。

**这里要澄清一下措辞**:维护者这句话事后看**没有被推翻**,只是被重新解释了(完整分析见第三章末尾)。"全仓库穷举搜不到调用点"这个静态事实站得住,但不能因此说"这个字段对所有用户都从没生效过"——更可能的情况是,其他用户的场景里这个字段本来就没被真正需要过(原因见后文),所以没人踩到这个坑,不代表维护者说谎或者没做过调研。

---

## 第三章:真正的病灶——`file_list` 从哪来,决定了一切

追着维护者的怀疑继续往下挖,找到了整个故事真正的核心机制。

`create_if_missing` 想要覆盖的那道"目录必须存在"的判断,实际代码在 `terrat_base_repo_config_v1.ml` 的 `derive` 函数里(不在 `terrat_change_match3.ml`,这是之前一直找错地方的原因):

```ocaml
let existing_dirs = Sln_set.String.of_list @@ CCList.map Filename.dirname file_list in
dirs
|> Sln_map.String.to_list
(* It's possible that someone configured a directory that doesn't actually
   exist... Filter those directories out *)
|> CCList.filter (fun (dirname, _) -> Sln_set.String.mem dirname existing_dirs)
```

这行代码无条件把"目录在 `file_list` 里没有对应文件"的 `dirs` 条目全部过滤掉,**完全没检查 `create_if_missing` 这个开关**。

这一步补齐了上一章那个"穷举搜不到调用点"的静态证据里缺的那一环:上一章只能说"没找到任何代码读这个字段",这一步是**直接找到了唯一一处判断"目录算不算存在"的代码,并确认它的条件表达式里就是没有 `create_if_missing` 这一项**——从"没找到证据"升级成了"找到了反证"。加上我们此前做过的实测(启用 `config_builder`、对不存在的目录设 `create_if_missing: true`、确认服务端接受了配置但那个目录从未变成 PR check),以及后续另外核对过 Terrateam 线上最新 HEAD(检查时点前约一周的提交)同样没有引用这个字段——三层证据(全仓库穷举、定位到具体判断逻辑、行为实测)互相印证,"这个字段在这段判断逻辑里不生效"这个结论到这里可以认为是扎实的。

但真正决定成败的是一个更底层的问题:`file_list` **到底从哪来**?

追下去发现:默认情况下,`file_list` 来自 **GitHub 的 Git Trees API**(`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=true`)——纯粹按 SHA 查询**已经提交到 git** 的文件树。跟 config_builder 生成了什么东西完全没有关系,俩是两条互不相交的流水线。

也就是说:**哪怕 `create_if_missing` 真的被正确实现了,也救不了我们这个场景**——因为它要判断"这个目录存在吗"依据的那份清单,压根不知道 CI 运行时临时生成了什么文件。

### 真正的开关:`tree_builder`

Terrateam 有另一个**完全独立**、几乎没有文档篇幅提到的功能,叫 `tree_builder`,跟 `config_builder` 是平级的两个开关:

```yaml
tree_builder:
  enabled: true
  script: <path-to-script>
```

它的作用就是**替换掉整个 `file_list` 的来源**——不再查 GitHub API,改成跑你指定的脚本,脚本吐出来的文件列表就是新的 `file_list`。这才是唯一能让"运行时生成、从未提交"的文件被现有匹配规则识别到的正确姿势。

而且一旦 `file_list` 里有了这个路径,**现有的通用 glob 规则会自动认出它**,根本不需要 `create_if_missing`,也不需要专门给它写一条 `dirs` 规则:

```yaml
dirs:
  "infrastructure/terragrunt/live/**/terragrunt.hcl":   # 这条规则原样保留
    when_modified: {...}
```

一旦 `.terragrunt-stack/bucket/terragrunt.hcl` 出现在 `file_list` 里,这条 `**` glob 天然就能匹配上。方案比之前设想的还要简单。

**回应一下第二章留下的疑问**:如果一个用户的 Stack 场景里,`file_list` 本身就通过某种方式(比如也用了 `tree_builder`,或者生成结果最终会被 commit 回 git)包含了目标目录,那这条 `derive` 过滤逻辑天然就会放行,跟 `create_if_missing` 有没有生效毫无关系——用户会观察到"我设了 `create_if_missing`,而且确实能用",但因果链可能根本不是他以为的那样。这只是一个合理推测,我们没有找到某个具体用户的配置去验证,但它能同时解释"代码里确实没有调用点"和"有人说他在用"这两个看似矛盾的事实,所以这里把它当作待验证的合理猜测写出来,而不是确凿结论。

---

## 第四章:即使找对了机制,还有五个连环坑在等着

理论理清楚了,写脚本、推上去,一路又踩了五个坑,一个接一个,每一个都足够让人怀疑"这条路是不是根本走不通"。

### 坑 4.1:输出格式——包一层还是不包一层

第一版脚本输出:

```python
json.dump({"files": [{"path": p} for p in sorted(files)]}, sys.stdout)
```

结果 build-tree 这一步**完全没有任何错误日志**,脚本自己的 print 输出正常,然后 job 直接跳到清理阶段,没有任何 PUT 请求、没有任何 traceback。诡异的静默失败。

后来用户直接从 UI(不是 GitHub Actions 日志流,GitHub Actions 日志里根本没有这条)截了一张图,报错是:

```
Failed to build repository tree
string indices must be integers, not 'str'
```

这个 Python `TypeError` 有非常固定的成因:

```python
x = "some string"
y = x["path"]   # TypeError: string indices must be integers, not 'str'
```

反推:如果外部 wrapper 代码是 `for f in result: f["path"]`,而 `result` 是我们发的 `{"files": [...]}` **字典**,Python 的 `for f in result` 遍历的是字典的**键**——`f` 会变成字符串 `"files"`,然后 `f["path"]` 精确地抛出这个错误。

修复:**输出必须是不带外层 key 的裸数组**:

```python
json.dump([{"path": p} for p in sorted(files)], sys.stdout)   # 不要 {"files": ...}
```

推上去之后,build-tree 真的 PASS 了。这个坑纯粹靠对一个 Python 异常消息做逆向推理才解开,没有任何文档提到过 tree_builder 脚本 stdout 的确切 schema。

### 坑 4.2:build-config / build-tree 不会跑在你自己的 self-hosted runner 上

这是个跟 Stack 本身无关、但只要用 `config_builder`/`tree_builder` 就一定会撞上的问题。

我们用 GitHub Actions 的 `workflow_dispatch` + ARC(Actions Runner Controller)自建 runner 跑 Terrateam,`.terrateam/config.yml` 里配了:

```yaml
workflows:
  - tag_query: ""
    runs_on: ["terrateam"]   # 指向自建 runner
```

正常的 plan/apply 会乖乖跑在自建 runner 上(这上面挂载了一个 legacy 的 vault ServiceAccount token,pre-hook 要用它登录 vault)。但 `build-config`/`build-tree` 这两类特殊 job,**完全无视这个 `runs_on` 配置**,永远走 `workflow_dispatch` 定义里的默认值(在我们的 `.github/workflows/terrateam.yml` 里就是 `ubuntu-latest`)。

去读 Terrateam 服务端源码确认了这不是配置问题,是硬编码行为:

```ocaml
(* terrat_vcs_event_evaluator2_wm_sm_build_config.ml *)
runs_on = None;
```

派发 build-config/build-tree 这类 job 时,`runs_on` 参数写死是 `None`,不会读我们配的那个值。

后果:每次 build-config/build-tree 一跑,那条给自建 runner 准备的 vault token 拷贝步骤(`cp /home/runner/sa-legacy-token/token ...`)就会因为 `ubuntu-latest` 上根本没有这个挂载点而报错 "No such file or directory",把整个 job 拖挂。

修复(两个字符):

```yaml
- name: Stage K8s SA token for Vault auth
  run: cp /home/runner/sa-legacy-token/token $RUNNER_TEMP/vault-sa-token || true
```

这一步对 build-config/build-tree 本来就没用(它们不需要 vault),让它失败不阻断后续即可。

### 坑 4.3:这个修复必须同时打在 base 分支上,不能只改 PR 分支

`tree_builder` 需要额外构建一份 **dest branch(合并目标分支)** 的文件树,用来跟 PR 分支的树做 diff。这意味着 Terrateam 会单独派发一个 "build-tree \<dest-branch-name\>" 的 job,**checkout 的是 base 分支的内容**,当然也会用 base 分支自己那份 `.github/workflows/terrateam.yml`。

我们只把 `|| true` 这个修复提交到了功能分支(PR 分支),base 分支上还是老版本——于是 dest-branch 那个 build-tree job 死循环般地卡在 "Queued",点开一看是同样的 vault token 报错,`|| true` 完全没生效,因为它压根不在那个分支的文件里。

**必须把这一行修复单独提交、推送到 base 分支**(不是通过 PR,是直接 push,如果分支有保护规则可能需要 bypass 权限)。

### 坑 4.4:先有鸡还是先有蛋——脚本文件本身也得先进 base 分支

修完 vault token 的问题,dest-branch 的 build-tree 这次是真的跑起来了,但又失败,报错变成:

```
line 3: infrastructure/terragrunt/tools/stack-tree-builder.py: No such file or directory
```

原因:dest-branch 的 build-tree job **用 PR 分支配置的脚本路径,去 base 分支自己的代码快照里找这个文件**——但这个脚本此刻只存在于 PR 分支,还没合并进 base 分支,自然找不到。

这是个结构性的先有鸡还是先有蛋问题:**要测试一个新的 `tree_builder`/`config_builder` 脚本,光在 PR 分支加是不够的**,只要涉及"对比 dest branch"的场景,脚本文件本身必须已经存在于 base 分支——哪怕还没在那边启用这个功能。

解法:单独把脚本文件(不启用 `tree_builder` 配置,只是把 `.py` 文件本身)也 commit、push 到 base 分支。

### 坑 4.5:即使 dirspace 终于被发现了,plan job 自己的工作目录里还是空的

这是最后一道坎。经过前面四个坑,`.terragrunt-stack/bucket` 终于作为一个真正的 dirspace check 出现在 PR 里了——**这本身已经是个突破**,证明了整套机制是能打通的。

但它 plan 失败了:

```
FileNotFoundError: [Errno 2] No such file or directory:
'/github/workspace/infrastructure/terragrunt/live/google-cloud-storage/dev/stack-test/.terragrunt-stack/bucket'
```

原因:负责跑 `terraform plan` 的这个 job,和负责生成 `file_list`(即 build-tree)的那个 job,是**完全独立的两次 checkout**。`tree_builder` 只是让 Terrateam"知道"这个路径该存在,但 plan job 自己的工作目录从来没跑过 `terragrunt stack generate`,目录当然是空的。

解法:再加一个 `hooks.all.pre` 步骤,在**每一次** plan/apply 之前都重新生成一遍 stack:

```yaml
hooks:
  all:
    pre:
      - type: run
        visible_on: always
        cmd:
          - sh
          - infrastructure/terragrunt/tools/generate-stacks.sh
```

### 附赠彩蛋坑:Terrateam 会对 hook 里的 `cmd` 字符串做变量替换,别用裸 `$`

这是更早期调试这个 hook 脚本时踩的坑,单独拎出来记一下,因为它极其隐蔽。

Terrateam 执行 `hooks.*.cmd` 数组里的命令字符串之前,会先用 Python 的 `string.Template(s).substitute(env)` 对里面的 `$VAR`/`${VAR}` 做一次变量替换——**在 shell 真正拿到这条命令之前**。如果你在 `cmd` 里直接写了 shell 变量或命令替换语法(比如 `$f`、`$(dirname "$f")`),这个替换阶段会把它们当成"要替换的占位符",要么因为找不到对应变量直接报错(`Missing environment variable: f`),要么因为语法不认识直接崩(`Invalid placeholder in string`)。

按 Python `string.Template` 的规则用 `$$` 转义理论上应该管用,但实测对着真实的 Terrateam 流水线**并不总是够**(本地模拟 Python 行为完全正确,线上跑起来还是炸)。最后可靠的解法是**把逻辑整个挪进一个真正的、提交进仓库的脚本文件**,`cmd` 数组里只写脚本路径,不写任何裸 `$`:

```yaml
cmd:
  - sh
  - infrastructure/terragrunt/tools/generate-stacks.sh   # 只有路径,没有内联的 $ 语法
```

因为只有 `cmd` 数组里的字面字符串会被模板替换,脚本**文件内容**不会被这套机制处理。

还有一个配套小坑:这个执行环境用的是 `sh`(POSIX shell),不是 `bash`。如果脚本里写了 bash 专属语法(比如配合 `find -print0` 常用的 `read -r -d ''`),会报 `Illegal option -d`——因为 POSIX `sh` 的 `read` 根本没有 `-d` 这个选项。改用最朴素的 `for f in $(find ...)` 循环(牺牲一点对文件名里空格的健壮性,但这在我们的仓库里不是问题)。

---

## 第五章:最终能跑通的完整配置

把上面所有坑填平之后,最终方案长这样。

### `.terrateam/config.yml`

```yaml
version: "1"

# 独立于 config_builder 的另一个开关,这才是能让"运行时生成、未提交"的
# 目录被识别成 dirspace 的正确机制。
tree_builder:
  enabled: true
  script: infrastructure/terragrunt/tools/stack-tree-builder.py

hooks:
  all:
    pre:
      # ...(原有的 vault 认证 hook)...
      - type: run
        visible_on: always
        cmd:
          - sh
          - infrastructure/terragrunt/tools/generate-stacks.sh   # 每次 plan/apply 前重新生成

workflows:
  - tag_query: ""
    runs_on: ["terrateam"]
    engine:
      name: terragrunt
      version: "1.1.3"        # 顶层 workflows[].engine 就行,不需要额外的顶层 engine 块
    plan:
      - type: plan
    apply:
      - type: apply

dirs:
  # 这条规则原样保留,不用给 Stack 生成的目录单独加规则
  "infrastructure/terragrunt/live/**/terragrunt.hcl":
    when_modified:
      file_patterns:
        - "${DIR}/**/*.hcl"
        - "${DIR}/*.tf"
        - "infrastructure/terragrunt/catalog/**"
        - "infrastructure/terragrunt/root.hcl"

  "infrastructure/terragrunt/catalog/**":
    when_modified:
      file_patterns: ["__suppress__"]
```

### `.github/workflows/terrateam.yml`(PR 分支和 base 分支都要改)

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Stage K8s SA token for Vault auth
    run: cp /home/runner/sa-legacy-token/token $RUNNER_TEMP/vault-sa-token || true   # <- 加上 || true
  - name: Run Terrateam Action
    ...
```

### `infrastructure/terragrunt/tools/stack-tree-builder.py`

```python
#!/usr/bin/env python3
"""
tree_builder.enabled=true 之后,这个脚本的输出会完全替代 Terrateam
默认从 GitHub Git Trees API 拿到的 file_list —— 这份清单只反映已提交
的文件,永远不会包含 config_builder/tree_builder 在 CI 里临时生成的
东西。这里把 git 已跟踪文件和 Stack 生成的文件做并集上报,所以完全
没用 Stack 的目录不受影响(纯加法,不是替换)。

重要:输出必须是不带外层 key 的裸 JSON 数组,包一层 {"files": [...]}
会导致 Terrateam runner 侧崩溃("string indices must be integers, not 'str'"),
具体原因见正文第四章。
"""
import json
import os
import subprocess
import sys

LIVE_ROOT = "infrastructure/terragrunt/live"


def log(message):
    print(f"[stack-tree-builder] {message}", file=sys.stderr)


def git_tracked_files():
    result = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines() if line]


def find_stack_dirs():
    for dirpath, _, filenames in os.walk(LIVE_ROOT):
        if "terragrunt.stack.hcl" in filenames:
            yield dirpath


def generate_stack(stack_dir):
    subprocess.run(
        ["terragrunt", "stack", "generate", "--non-interactive"],
        cwd=stack_dir, check=True, capture_output=True, text=True,
    )


def generated_files(stack_dir):
    gen_root = os.path.join(stack_dir, ".terragrunt-stack")
    if not os.path.isdir(gen_root):
        return
    for dirpath, _, filenames in os.walk(gen_root):
        for filename in filenames:
            yield os.path.relpath(os.path.join(dirpath, filename))


def main():
    sys.stdin.read()  # Terrateam 会往 stdin 写东西,格式我们不关心,读掉即可

    files = set(git_tracked_files())
    for stack_dir in find_stack_dirs():
        try:
            generate_stack(stack_dir)
        except subprocess.CalledProcessError as e:
            log(f"terragrunt stack generate failed in {stack_dir}: {e.stderr}")
            continue
        for path in generated_files(stack_dir):
            files.add(path)
            log(f"added generated file: {path}")

    # 裸数组,不要包一层 {"files": ...}
    json.dump([{"path": p} for p in sorted(files)], sys.stdout)


if __name__ == "__main__":
    main()
```

### `infrastructure/terragrunt/tools/generate-stacks.sh`

```sh
#!/bin/sh
set -e

# 这里故意不用 find -print0 / read -r -d '',因为这个 hook 跑在 POSIX
# sh 下,sh 的 read 没有 -d 这个 flag(bash 才有)。用最朴素的词分割
# 循环,在目录名不含空格的前提下是安全的。
for f in $(find infrastructure/terragrunt/live -name "terragrunt.stack.hcl"); do
  echo "generating stack: $f"
  (cd "$(dirname "$f")" && terragrunt stack generate --non-interactive)
done
```

---

## 第六章:全面采用 Stack,对现有架构意味着什么代价

打通了不等于应该马上全仓库铺开。把这套东西从"一个测试用例"扩展到"所有 live 实例都用 Stack 生成",有几个非常值得三思的代价:

1. **代码审查透明度下降**。现在每个 live 实例的完整 `terragrunt.hcl` 是提交进 git 的,PR diff 里能直接看到改了什么。切到 Stack 后,PR 里只能看到 `values = {...}` 那几行,渲染结果看不见,得信任生成过程。

2. **破坏半径覆盖全仓库,不只是 Stack 相关部分**。`tree_builder` 替换的是**整个仓库**的 `file_list`——这一个自己维护的脚本要是哪天悄悄坏了(比如我们踩的那个输出格式坑,完全没有清晰的报错),影响的是全仓库所有 plan/apply,不只是用了 Stack 的那几个目录。

3. **base 分支变成了必须长期维护的关键路径**,而且是一段 Terrateam 官方不保证兼容性的自定义脚本——他们内部任何一次 wrapper 契约变化,都可能在未来某次升级后悄悄弄坏它。

4. **每次 plan/apply 都要重新生成全部 Stack**,而不是只生成这次改动涉及的那个。Stack 数量一多,这个开销会线性增长。

5. **状态迁移风险**。生成出来的路径如果跟手写的旧路径不完全一致,state key 就变了,需要谨慎的 `terraform state mv`。而且"编辑 `values` 块导致某个 unit 块消失"这种操作,比"删除整个 live 目录"更容易在不经意间发生,而 Terrateam 感知不到要 destroy 什么。

**建议**:从新增的、非关键路径的服务开始小范围试点,而不是把现有 live 目录批量迁移过去。

---

## 第七章:如实交代——这套方案有哪些不体面的地方

前面写的是"怎么把它跑通",这一章说说不好听的部分。这些不是锦上添花的免责声明,是真实存在、目前**没有解决**的问题,决定要不要在生产环境铺开之前必须知道。

### 7.1 `|| true` 是在掩盖错误,不是在修复错误

修复 vault token 那一步用的 `|| true`,本质上是"不管这步成不成功,都当它成功"。这在 build-config/build-tree 场景下是合理的(它们确实不需要 vault),但这是一个**很容易被滥用、也很容易在未来引入新问题时把真实报错吞掉**的模式。如果哪天这个 hook 步骤被改成承担别的职责,或者报错原因从"没有这个文件"变成别的更严重的问题,`|| true` 会让它一样悄无声息地"成功"。这行改动能生效,不代表它是干净的解法,它是一个针对已知场景的精准妥协,不要把它当成"这类报错都可以这么处理"的通用模式。

### 7.2 整套方案完全建立在对私有实现细节的逆向工程之上,官方不保证兼容性

`tree_builder` 输出必须是裸数组、`workflows[].engine.version` 不生效但顶层 `engine.version` 生效、build-config/build-tree 忽略 `runs_on`——这些结论没有一条来自官方文档,全部来自读源码和读报错反推出来的。这意味着:

- Terrateam 任何一次不涉及"breaking change"公告的小版本升级,都可能因为改了内部 wrapper 的解析逻辑而**悄悄弄坏**我们的脚本,而且大概率不会有清晰的报错(参考坑 4.1,静默失败是常态,不是例外)。
- 我们在 issue 里明确跟维护者说了"不需要你们改代码,我们自己的方案已经跑通",这意味着**官方没有义务保证这条路径未来继续可用**——它能跑,纯粹是当前这个版本的实现细节恰好允许,不是一个被设计、被测试、被承诺维护的功能组合。

### 7.3 这套方案只在一个极简的玩具用例上验证过

自始至终验证用的都是同一个测试夹具:一个 stack、一个 unit、一个 GCS bucket。没有验证过的场景包括但不限于:

- 一个 `terragrunt.stack.hcl` 里有**多个** `unit` 块,会不会互相干扰
- Stack 之间有依赖关系(一个 stack 的 unit 依赖另一个 stack 生成的 unit)
- 仓库里 stack 数量变多之后,`generate-stacks.sh` 每次全量重新生成的耗时会线性增长到什么程度——没有做过任何性能测量
- `terraform apply`(不只是 plan)在这个生成出来的 dirspace 上是否能完整走通,包括后续的状态文件写入、锁机制——**我们只验证到 plan 通过**,没有跑完一次真正的 apply
- 并发场景:多个 PR 同时触碰不同的 stack 时,`tree_builder` 这种"整仓库文件清单由一个脚本决定"的模式会不会有竞态问题

换句话说:证明了"机制可行",没有证明"生产可用"。

### 7.4 精确依赖追踪这个设计目标,最终被放弃了

第二章花了不少篇幅做的"递归解析 catalog 依赖、只精确触发相关 stack"这个方案,最终没有用上——因为 `config_builder` 这条路整体被放弃了。最终生效的方案用的是**最粗糙**的触发规则:沿用现有 `live/**/terragrunt.hcl` 那条通用 glob,里面写的是整个 `catalog/**`。也就是说,任何一个 catalog 模块的改动,都会触发**所有** Stack 生成的 dirspace 重新 plan,不管它们实际有没有依赖那个模块。这是我们在能力和精力之间做的取舍,不是刻意的架构选择,以后如果 Stack 数量变多,这里会成为一个明显的效率浪费点,值得回头补上第二章那套依赖追踪逻辑(换个方式接进 tree_builder 里)。

### 7.5 直接 push 到受保护的 base 分支,是绕过规则,不是走正规流程

修复 base 分支的两处改动(`|| true`、脚本文件本身)都是**直接 push** 上去的,GitHub 明确返回了警告:

```
remote: Bypassed rule violations for refs/heads/terraform-atlantis-dynamodb:
remote: - Changes must be made through a pull request.
```

这条分支保护规则的本意大概率就是"重要改动要有人审查",这次的绕过是权限允许、也确实是为了解决一个阻塞性问题,但严格说不符合团队自己定的流程,应该事后补一个说明性的 PR 走一下审查记录,而不是当作理所当然。

### 7.6 这次的"成功"依赖于一个此前从未被独立验证过的假设链

回顾整个过程会发现,最终方案是建立在一连串**没有人验证过、只是恰好都对了**的假设上:`file_list` 的并集语义、`tree_builder` 和现有 glob 规则的组合方式、`hooks.all.pre` 在每个 job 里都会重新跑一遍。这些假设目前只被我们自己的一次性测试证实,没有经过 Terrateam 官方确认"这就是预期用法"。如果后续要正式采用,建议至少让维护者在 issue 里确认一下这条路径是不是他们认可的用法,而不只是"我们试出来能跑"。

---

## 写在最后:这不是一个"能用"的方案,是一个"能用但不放心"的方案

准确地说:上面六章证明的是"技术上可行",不是"官方支持、可以放心长期依赖"。核心问题不是某个坑修不好,而是整个方案建立在两个互相独立、原本各自服务于别的目的的开关(`tree_builder` + `config_builder`/hook)拼出来的效果——不是 Terrateam 为 Stack 场景设计的路径。它认不认识 Stack 这件事,压根没在他们的架构里被考虑过,我们只是找到了一个"文件清单从哪来"这个更底层的口子,绕了过去。

这也是为什么维护者在 issue 里说的是"以后可能会做原生支持",而不是"你可以用 tree_builder"——因为连他们自己都没把这个组合当成一个正式方案。

所以现实的选择大概是三条:

1. **先用着,当成一个心知肚明的 workaround**,接受第七章列的那些风险(尤其是"官方升级可能悄悄弄坏它"),小范围用,别指望它长期免维护。
2. **等官方原生支持**——但目前没有时间表,提给官方的 issue 从提交到现在没有任何进展。
3. **暂时不用 Stack,继续手写 live 目录**,牺牲一些重复劳动换取现在这套"每个目录独立、行为可预测"的确定性。

这次调试前后经历了:2 次完整方案推翻重来、5 个独立的 Terrateam 自身 bug(其中至少 2 个此前没有人报告过)、1 个提给官方的 issue(附带完整复现步骤,已关闭)。全程没有改一行 Terrateam 的源码——最终方案是纯配置 + 两个几十行的脚本。

如果说有什么经验值得带走:**遇到"文档说能行但实测不行"的情况,别停在"大概是我配错了"这一层,直接去翻源码**。这次几乎每一个关键突破,都是靠读 OCaml 源码里那几行判断逻辑、或者反推一个 Python 报错的具体触发路径拿到的——文档在这类新功能/冷门功能上,永远滞后于代码的真实行为。
