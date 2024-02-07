---
title: 在 Kubernetes 中使用 External-DNS 管理域名
date: 2024-2-06 20:47:23
tags: [external-dns, dns, k8s, kubernetes]
categories: Devops
---

## 简介

在 Kubernetes 集群中，管理域名和将服务公开到外部网络是一个关键的任务。External-DNS 是一个强大的工具，它允许您通过 Kubernetes 资源来自动管理域名。这篇文章将介绍如何在 Kubernetes 中使用 External-DNS，以便轻松地将服务关联到域名，并确保域名与服务的 IP 地址保持同步。

接下来我就以我自身的一个实际用例来介绍一下。

## 安装 External-DNS

首先，您需要安装 External-DNS 到您的 Kubernetes 集群。可以使用 Helm 来简化这个过程。执行以下命令：

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install external-dns bitnami/external-dns \
  --set provider=your-dns-provider \
  --set provider.apiKey=your-api-key
```

请替换 `your-dns-provider` 和 `your-api-key` 为您的 DNS 提供商和相应的 API 密钥。

## 配置 External-DNS

一旦安装完成，您需要配置 External-DNS 以确保它知道要管理的域名。创建一个配置文件（例如 `external-dns-config.yaml`）并添加以下内容：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: external-dns
data:
  domainFilters: your-domain.com
  sources: ingress
  provider: your-dns-provider
  providerConfig:
    api-key: your-api-key
```

同样，替换 `your-domain.com`、`your-dns-provider` 和 `your-api-key` 为您的域名、DNS 提供商和 API 密钥。

然后，应用配置文件到集群中：

```bash
kubectl apply -f external-dns-config.yaml
```

## 部署 Ingress 资源

为了让 External-DNS 知道哪些服务关联到哪个域名，您需要使用 Ingress 资源。创建一个 Ingress 资源文件（例如 `example-ingress.yaml`）：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example-ingress
spec:
  rules:
  - host: your-service.your-domain.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: your-service
            port:
              number: 80
```

确保替换 `your-service` 和 `your-domain.com` 为您的服务名称和域名。

## 查看 External-DNS 工作

部署 Ingress 资源后，External-DNS 将会自动更新您的 DNS 记录。您可以使用以下命令检查 External-DNS 的日志：

```bash
kubectl logs -l app=external-dns
```

在日志中，您应该能够看到 External-DNS 已经识别并管理了您指定的域名。

## 结论

通过使用 External-DNS，您可以在 Kubernetes 中轻松地管理域名，而不必手动更新 DNS 记录。这不仅使得维护更加简便，而且确保了域名与服务的 IP 地址之间的同步。这对于需要频繁更改域名映射的场景非常有用，例如在开发和测试环境中。

希望这篇文章对您在 Kubernetes 中使用 External-DNS 有所帮助！