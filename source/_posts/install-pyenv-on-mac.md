---
title: Mac上pyenv的安装及使用
date: 2023-11-30 14:00:00
tags: [pyenv, mac, brew]
categories: ["开发","python"]
---

pyenv 是一个 Python 版本管理工具，可以让您在系统中轻松管理多个 Python 版本。通过 pyenv，您可以安装不同的 Python 版本，并针对特定项目或需求使用不同的 Python 版本。此外，pyenv 还可以管理全局 Python 版本和本地项目特定版本，让您能够更加灵活地管理 Python 环境。这可以帮助开发人员避免由于不同的项目需要不同版本的 Python 而引起的兼容性和依赖性问题。


## 安装
### 安装pyenv

在这里，使用Homebrew来安装pyenv，如果mac上还没有安装Homebrew，请参考[这里](https://brew.sh/)
```bash
brew update
brew install pyenv
```
### 为pyenv配置shell环境
本博主使用的是zsh环境，所以本篇文章仅以zsh为例，如需要配置其他shell环境，请参考[这里](https://github.com/pyenv/pyenv#set-up-your-shell-environment-for-pyenv)
```bash
echo 'export PYENV_ROOT="$HOME/.pyenv"' >> ~/.zshrc
echo '[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"' >> ~/.zshrc
echo 'eval "$(pyenv init -)"' >> ~/.zshrc
```
配置好后，重启我们的shell
```bash
exec "$SHELL"
```
## 使用
此时，我们已经安装了 pyenv，但它尚未为我们管理任何版本。如果我们询问 pyenv 它知道哪些版本，它只会报告它知道关于"system"的信息。
```bash
➜  ~ pyenv versions
* system (set by /Users/wenzizone/.pyenv/version)
```
### 基本使用
| 命令 | 描述 |
|:---:|:---|
|pyenv --version|查看 pyenv 的版本|
|pyenv versions|罗列当前已安装的所有 python 环境，<br>如果是当前正在使用的环境，则前面会有个 *|
|pyenv help|查看帮助|
|pyenv init|如果输入 pyenv 之后使用 tab 不补全，<br>可以使用该命令进行初始即可使用补全命令|

### 安装环境
| 命令 | 描述 |
|:---:|---|
|pyenv install -l|显示可以安装的版本列表|
|pyenv install 版本号|安装指定版本的 python|
|pyenv rehash|更新本地数据库，安装指定版本的 python 后使用|
### 环境应用
| 命令 | 描述 |
|:---:|---|
|pyenv global 版本号|更改本机版本，重启不会造成再次更改|
|pyenv local 版本号|会在当前目录创建 .python-version 文件，<br>并记录设置的 python 环境，<br>每次进入该目录会自动设置成该 python 环境|
|pyenv shell 版本号|更改当前 shell 下使用的 python 版本，<br>临时生效，优先级高于 global|
### 示例
1. 安装指定版本的python
```bash
➜  ~ pyenv install 3.12.0
python-build: use openssl@3 from homebrew
python-build: use readline from homebrew
Downloading Python-3.12.0.tar.xz...
-> https://www.python.org/ftp/python/3.12.0/Python-3.12.0.tar.xz
Installing Python-3.12.0...
.
.
.
Installed Python-3.12.0 to /Users/wenzizone/.pyenv/versions/3.12.0

➜  ~ pyenv versions
* system (set by /Users/wenzizone/.pyenv/version)
  3.12.0
```
2. 更该全局环境python版本
```bash
➜  ~ pyenv global 3.12.0

➜  ~ pwd
/Users/wenzizone
➜  ~ pyenv versions
  system
* 3.12.0 (set by /Users/wenzizone/.pyenv/version)
➜  ~ cd /tmp
➜  /tmp pyenv versions
  system
* 3.12.0 (set by /Users/wenzizone/.pyenv/version)
```
由此可见，全局的python版本已经被设置为3.12.0了
3. 设置当前目录使用python版本
```bash
➜  ~ cd /tmp
➜  /tmp pyenv local 3.12.0

➜  /tmp pyenv versions
  system
* 3.12.0 (set by /tmp/.python-version)
➜  /tmp cd
➜  ~ pyenv versions
* system (set by /Users/wenzizone/.pyenv/version)
  3.12.0

  ➜  /tmp ls -a
.
..
.python-version
Sublime Text.4cff18d2bab96a93366319a9e0fa060d.dc715bc726b62806c2cb0a28eb2303bb.sock
```
由此可见，在`/tmp`目录下，会自动使用3.12.0版本的python，其他目录都是使用系统自带了。主要，pyenv local命令会在当前目录下创建一个.python-version的文件
```bash
➜  /tmp cat .python-version
3.12.0
```
文件内容其实就是所用python对应的版本号