---
title: 使用pyenv-virtualenv管理python虚拟环境
date: 2023-11-30 14:59:49
tags: [pyenv, virtualenv, pyenv-virtualenv]
categories: ["开发","python"]
---
pyenv-virtualenv 是一个用于管理 Python 版本和虚拟环境的工具。通过 pyenv-virtualenv，您可以轻松地创建和管理多个 Python 版本，并为每个版本创建独立的虚拟环境。

要使用 pyenv-virtualenv，您需要先安装 pyenv。安装方法可以参考[这里](https://www.wenzizone.com/202311/install-pyenv-on-mac)  
然后，您可以使用 pyenv-virtualenv 插件来创建和管理虚拟环境。使用该插件，您可以为每个项目选择特定的 Python 版本，并在每个项目的环境中安装特定的库和依赖。

通过 pyenv-virtualenv，您可以避免在全局安装 Python 包时出现版本冲突的问题，并且能够在不同项目中使用不同的 Python 版本和依赖。

总之，pyenv-virtualenv 是一个方便的工具，能够帮助您轻松管理 Python 版本和虚拟环境，使项目开发更加灵活和高效。

## 安装
#### 方法一：Git Clone
```bash
cd .pyenv/plugins
git clone https://github.com/pyenv/pyenv-virtualenv.git # 安装virtualenv插件
```
#### 方法二：Homebrew
```bash
brew install pyenv-virtualenv
```

## 配置
无论使用上述的哪种方式进行的安装，请根据自身环境，将下方内容加到对应文件中： .bashrc or .zshrc
```bash
eval "$(pyenv virtualenv-init -)"
```

## 使用
### 基本使用
| 命令  | 描述  |
|---|---|
| pyenv virtualenv 3.8.3 env383	  |创建 3.8.3 版本虚拟环境|
| pyenv virtualenvs	  |显示环境|
|pyenv activate env383	   |激活使用指定的虚拟环境|
|pyenv deactivate	   |退出当前虚拟环境   |
|rm -rf .pyenv/versions/3.8.3	   |删除版本环境   |
|rm -rf .pyenv/versions/env383	|删除虚拟环境|

## 示例
1. 创建指定python版本的虚拟环境
```bash
pyenv virtualenv 3.10.13 demo

➜ python --version
Python 3.12.0

➜ pyenv activate demo
pyenv-virtualenv: prompt changing will be removed from future release. configure `export PYENV_VIRTUALENV_DISABLE_PROMPT=1' to simulate the behavior.
(demo) ➜ python --version
Python 3.10.13
```
从上面可以看到，在我们没有切换到虚拟环境前，python的版本是`3.12.0`，但当我面激活虚拟环境后，python的版本就好变成了`3.10.13`了。

2. 自动激活和退出虚拟环境
在需要使用虚拟环境的目录（通常是项目目录）中：

- 建立一个 .python-version 的文本文件
- 将虚拟环境名称（如 demo ）写在里面  

之后每次进／出该目录时，虚拟环境都将自动激活／退出。