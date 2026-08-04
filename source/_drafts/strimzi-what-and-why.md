---
title: Strimzi 是什么，为什么要用 Operator 管理 Kafka
date: 2026-08-04 14:00:00
tags: [strimzi, kafka, kubernetes]
categories: Devops
cover: /images/strimzi/strimzi-what-and-why.png
description: '面向 Strimzi 新手的入门篇：讲清楚手工在 K8s 上跑 Kafka 的真实痛点、Operator 模式的核心机制，以及 Strimzi 的 CRD 全景和角色分工。'
---

这是一个 Strimzi 系列的第一篇。后面几篇会依次展开 `Kafka`/`KafkaNodePool`（集群拓扑怎么声明）、`KafkaTopic`/`KafkaUser`（把 topic 和权限也纳入 GitOps）、`KafkaConnect`/跨集群/可观测性这些具体话题；最后一篇回到我们自己的环境，看看这套东西实际落地了多少。但在那之前，先花一篇讲清楚 Strimzi 到底是什么、解决什么问题——这样后面每一篇的设计选择，才有地方"挂"。

![Strimzi 是什么：为什么要用 Operator 管理 Kafka？](/images/strimzi/strimzi-what-and-why.png)

---

## 1. 手工在 K8s 上跑 Kafka 的真实痛点

如果你在 Kubernetes 上手工部署过 Kafka（比如直接用 Bitnami 这类 Helm chart），大概率遇到过这几件事：

1. **StatefulSet + PVC 的手工编排。** 副本数、存储、滚动升级的顺序，都需要人来盯着——扩缩容的时候改错一个字段，就可能导致数据丢失或者服务中断。
2. **证书与密码轮换的"人肉"噩梦。** 拿一个真实的例子来说，我们环境里跑的 Bitnami Kafka chart，升级的时候要这样手动导出密码：

   ```bash
   export INTER_BROKER_PASSWORD=$(kubectl get secret --namespace "kafka" kafka-user-passwords -o jsonpath="{.data.inter-broker-password}" | base64 -d)
   export CONTROLLER_PASSWORD=$(kubectl get secret --namespace "kafka" kafka-user-passwords -o jsonpath="{.data.controller-password}" | base64 -d)

   helm upgrade --install kafka -n kafka kafka/ --debug \
     --set kafka.sasl.interbroker.password=$INTER_BROKER_PASSWORD \
     --set kafka.sasl.controller.password=$CONTROLLER_PASSWORD
   ```

   每次升级都要先手动把密码从 Secret 里导出来，再原样传回去——这本质上不是一个声明式操作，密码在"导出-传入"这个过程中既容易出错，也多了一次不必要的暴露面。
3. **运维经验没法"代码化"。** 什么时候该先升级 controller 再升级 broker、滚动重启要等多久确认健康再继续——这些经验往往只存在于某个人的脑子里或者一篇内部文档里，没有变成可以被系统执行的逻辑，也没法在团队内部复用。

## 2. Operator 模式的核心机制：调谐循环

Kubernetes Operator 要解决的就是上面这类问题：把"怎么正确运维一个复杂系统"这件事，从人的经验变成可以被机器持续执行的代码。它的核心机制是一个**调谐循环（Reconciliation Loop）**：

- Operator 持续监听一个自定义资源（CRD）里声明的**期望状态**（Desired State）；
- 和集群里的**实际状态**（Current State）做对比；
- 如果两者不一致，就自动执行必要的变更，让实际状态收敛到期望状态。

这个循环不断重复，无需人工干预。用一句话总结：**Operator 把专家的运维经验写成了代码，普通用户不需要懂内部细节，也能安全地执行复杂的运维任务。** Strimzi 就是这个模式在 Kafka 上的具体实现。

## 3. Strimzi 的 CRD 全景

Strimzi 提供了一组自定义资源，覆盖 Kafka 生态的不同层面。这一篇先混个脸熟，具体怎么用留给后面几篇：

- **`Kafka` / `KafkaNodePool`**：定义 Kafka 集群本身——版本、broker/controller 拓扑、存储、监听器。下一篇细讲。
- **`KafkaTopic` / `KafkaUser`**：定义集群里的 topic 和用户权限，交给 Entity Operator 管理。Part 3 细讲。
- **`KafkaConnect` / `KafkaConnector` / `KafkaMirrorMaker2` / `KafkaBridge`**：连接外部系统、跨集群复制、HTTP 桥接。Part 4 细讲。

## 4. Cluster Operator vs Entity Operator

Strimzi 内部不是一个单体程序，而是拆成了职责分明的几个角色：

- **Cluster Operator**：集群的"指挥官"，负责整个 Kafka 集群的生命周期——部署、升级、以及底层 Pod/存储的维护。
- **Entity Operator**：由 **Topic Operator** 和 **User Operator** 两部分组成，专门负责集群内部 topic 和用户的管理，分别对应 `KafkaTopic` 和 `KafkaUser` 这两个 CRD。

Cluster Operator 管"集群这个大盒子"，Entity Operator 管"盒子里具体的 topic 和用户"——两者分工协作，谁也不用了解对方的实现细节。

## 5. 动手最小例子

不需要连接任何云账号，本地用 kind 或 minikube 就能把整个流程跑一遍。

先装 Strimzi（以 Helm 方式为例）：

```bash
helm repo add strimzi https://strimzi.io/charts/
helm install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka --create-namespace \
  --set watchAnyNamespace=true
```

`watchAnyNamespace=true` 让 Cluster Operator 监听所有命名空间里的 `Kafka` 资源，而不是只盯着自己所在的命名空间。

然后声明一个最小的单节点 KRaft 模式 `Kafka` CR：

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-cluster
  namespace: kafka
  annotations:
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: 3.8.0
    replicas: 1
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
    config:
      offsets.topic.replication.factor: 1
      transaction.state.log.replication.factor: 1
      transaction.state.log.min.isr: 1
    storage:
      type: ephemeral
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

`kubectl apply -f` 提交之后，观察 Cluster Operator 怎么把这个声明变成实际的 Pod：

```bash
kubectl get pods -n kafka -w
```

几分钟之内，你会看到 broker/controller 的 Pod 依次起来，Entity Operator 的 Pod 也会自动创建——这一切都不需要手动执行任何 `kubectl exec` 或者手工导出密码。

## 6. 后面几篇要看什么

这一篇只是打了个底。我们自己的环境里，QA 已经装上了 Strimzi 的 Cluster Operator（`watchAnyNamespace: true`），后面几篇会依次展开 `KafkaNodePool` 怎么声明集群拓扑、`KafkaTopic`/`KafkaUser` 怎么把 topic 和权限也纳入 GitOps、`KafkaConnect` 这些连接生态怎么用——最后一篇再回到我们自己的环境，如实盘点这套东西目前到底用上了多少、还差什么。
