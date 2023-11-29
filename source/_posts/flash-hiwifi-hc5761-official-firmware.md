---
title: 极路由hc5761刷openwrt 之 刷原厂固件
date: 2023-11-29 14:00:00
tags: [openwrt, 极路由, hc5761]
categories: Devops
---
博主手中有一台老物件，极路由Hiwifi HC5761，奔着物尽其用的原则。就想着拿它来刷个openwrt做一个旁路网关，网上搜索了一番，刷openwrt共分成以下几个步骤。
1. root路由器，开启SSH
2. 输入bread
3. 进入bread模式，修改mac地址
4. 在bread模式中刷入openwrt固件

由于极路由厂家早就黄了，极路由的插件市场也早就不再可用，好在网上还是找到了临时开启ssh的方法，
使用https://www.hiwifi.wtf/网站提供的方法，只需要本机访问http://192.168.199.1/cgi-bin/turbo/proxy/router_info地址，就可以获取到极路由uuid，并结合local_token就可以活得cloud token，然后就可以开启ssh了。

但经过博主的多方测试。http://192.168.199.1/cgi-bin/turbo/proxy/router_info 得到的结果如下：
```json
{
  "code": 0,
  "debug_info": {
    "rt_api_version": "1.1.2-20170707.1",
    "env": {
      "http": {
        "query_string": "",
        "remote_addr": "192.168.199.188",
        "request_uri": "/cgi-bin/turbo/proxy/router_info",
        "server_addr": "192.168.199.1"
      }
    },
    "rt_time_in": 859980,
    "rt_rom_version": "1.4.11.21001s 180510-055033",
    "rt_time_use": 70,
    "rt_time_out": 860050
  },
  "msg": "成功",
  "data": {},
  "req_id": 0
}
```
并不能获取到极路由的uuid，整个data中的数据都缺失了。猜测，该路由器控件可能是被动了手脚，就此，死马当活马医吧，先尝试恢复官方控件再说。

## 博主的操作环境
电脑: MacBook  
系统: MacOS Ventura v13.6  
路由器: Hiwifi HC5761  
版本: 不详  

## 操作步骤
### 1.下载官方固件  

下载地址：https://github.com/xjtuecho/HIWIFI/tree/master/Factory  
version: HC5761-sysupgrade-20180510-0dd7abd0.bin  

极路由支持tftp方式刷机，要求是:
- 电脑装有tftp server
- 电脑IP需为192.168.1.88
- 固件名需为recovery.bin

### 2.开启Mac的tftp Server

mac系统原生就自带了tftp server，只是默认情况下并没有启动而已。tftp server的默认目录是
`/private/tftpboot` 

接下来，我们只需要把固件放到这个目录，并启动tftp server即可
```bash
cp HC5761-sysupgrade-20180510-0dd7abd0.bin /private/tftpboot/recovery.bin
sudo launchctl load -F /System/Library/LaunchDaemons/tftp.plist
sudo launchctl start com.apple.tftpd

sudo chmod 777 /private/tftpboot
sudo chmod 777 /private/tftpboot/*
```

需要测试一下能否正常下载，指令如下：
```bash
cd /tmp
tftp localhost
tftp> get recovery.bin
tftp> q
ll recovery.bin
```

### 3.对路由器进行刷机
将mac的ip地址修改为`192.168.1.88`，并和路由器通过网线连接上。   
然后按住极路由的RESET键（极3直接按，极2等老机器需要用尖锐物（笔、取卡针、通针等）），给极路由通电。  
观察电脑中tftp server的发送情况（可通过网速看出来），传输完毕即可松开RESET键。   
路由器面板的多个灯会轮流亮起（跑马灯效果），跑完以后，路由器自动重启，刷机即完成。 

### 4.网页查看极路由设备型号和固件版本
路由器网页后台的页脚，能看到“系统版本：设备型号 - 固件版本”，如图：
![极路由设备型号和固件版本](https://openwrt.io/img/gee-device-model-and-rom-version-in-web.png "网页查看极路由设备型号和固件版本")

### 5.查看uuid信息
访问http://192.168.199.1/cgi-bin/turbo/proxy/router_info 得到的结果如下：
```json
{
  "code": 0,
  "debug_info": {
    "rt_api_version": "1.1.2-20170707.1",
    "env": {
      "http": {
        "query_string": "",
        "remote_addr": "192.168.199.188",
        "request_uri": "/cgi-bin/turbo/proxy/router_info",
        "server_addr": "192.168.199.1"
      }
    },
    "rt_time_in": 859980,
    "rt_rom_version": "1.4.11.21001s 180510-055033",
    "rt_time_use": 70,
    "rt_time_out": 860050
  },
  "msg": "成功",
  "data": {
    "agreement_accepted": true,
    "systime": 1607307436,
    "support_client_bind": 1,
    "storage": {
      "minsize": "3000M",
      "type": "SD"
    },
    "wireless": {
      "5G": {
        "turbo": false,
        "available": false
      },
      "2.4G": {
        "turbo": false,
        "available": true
      }
    },
    "mac": "D4:EE:07:0A:XX:XX",
    "uuid": "c29054da-b894-11e3-851b-d4ee070axxxx",
    "country": "CN",
    "remote_info": {
      "mac": "1C:1B:B5:8F:XX:XX",
      "phy": "2.4G",
      "ip": "192.168.199.188"
    },
    "board": "HC5671",
    "auto_bind": 0,
    "type": "router",
    "wan_up": true,
    "version": "1.4.11.21001s 180510-055033",
    "model": "HC5671",
    "is_onekey_reset": false,
    "totalram": 129376256,
    "uptime": 861,
    "issetsafe": 1
  },
  "req_id": 0
}
```
从上面的返回结果可以清楚的看到路由器的uuid了   

到此，我们为了给极路由刷Openwrt的第一步做好了准备


#### 额外步骤，关闭tftp server
刷完原厂固件后，我们并不在需要tftp server了，执行下面的命令将其关闭
```bash
sudo launchctl unload -F /System/Library/LaunchDaemons/tftp.plist
```

参考内容：
- https://github.com/xjtuecho/HIWIFI
- https://www.wirelessphreak.com/2016/07/using-built-in-tftp-server-on-os-x-el.html
- https://openwrt.io/docs/gee/#_2