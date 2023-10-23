---
title: 给github配置代理
date: 2023-10-23 08:12:10
tags: [github, proxy]
categories: Devops
---

# 配置Git代理

如果你需要通过代理连接Git服务，请按照以下步骤进行配置：

## 1. 查看当前Git配置

首先，打开终端并输入以下命令来查看当前的Git配置信息：

```bash
git config --global --get-all http.proxy
git config --global --get-all https.proxy
```

如果显示空的输出或没有输出，则表示当前没有配置代理。

## 2. 配置代理

### 通过HTTP代理访问Git服务

运行以下命令来配置HTTP代理：

```bash
git config --global http.proxy http://代理服务器IP:代理服务器端口
```

将"代理服务器IP"和"代理服务器端口"替换为你实际使用的代理服务器的IP地址和端口。

### 通过HTTPS代理访问Git服务

运行以下命令来配置HTTPS代理：

```bash
git config --global https.proxy http://代理服务器IP:代理服务器端口
```

同样，将"代理服务器IP"和"代理服务器端口"替换为你实际使用的代理服务器的IP地址和端口。

## 3. 验证代理配置

运行以下命令来验证代理配置是否成功：

```bash
git config --global --get-all http.proxy
git config --global --get-all https.proxy
```

确认输出与你配置的代理信息相符即可。

## 结论

通过以上步骤，你可以成功配置Git代理。请确保代理服务器的参数正确，并根据需要选择配置HTTP代理或HTTPS代理。希望对你有所帮助！
