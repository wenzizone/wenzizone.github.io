---
title: 极路由hc5761刷openwrt
date: 2024-01-20 14:00:00
tags: [openwrt, 极路由, hc5761]
categories: Devops
---
本篇进入主题，将按照以下步骤把极路由HC5761刷成opentwrt系统。
1. root路由器，开启SSH
2. 输入bread
3. 进入bread模式，修改mac地址
4. 在bread模式中刷入openwrt固件

## 博主的操作环境
电脑: MacBook  
系统: MacOS Ventura v13.6  
路由器: Hiwifi HC5761  
版本: 0.9012.1.9277s

## root路由器，开启SSH

博主在这里整理了三种方法

#### 1.纯手动操作
1. 访问http://192.168.199.1/local-ssh/ 获取local_token
2. 访问http://192.168.199.1/cgi-bin/turbo/proxy/router_info地址，在返回的json中找到uuid，
3. 返回https://www.hiwifi.wtf/网站，填入local_token和uuid提交后就可以获得cloud token
4. 进入路由器http://192.168.199.1/local-ssh/页面，填入第三步获取到的cloud token，提交后即可看到提示`Success: ssh port is 22`。
> 注意：第四步有可能会失败，如果失败，只需要重复上面三步即可。

这时我们就获取到了临时的ssh权限。[用户名：root，密码：路由器管理密码]，此时退出ssh后，就不能继续，所以需要执行命令永久开启ssh
```shell
/etc/init.d/dropbear enable && /etc/init.d/dropbear start
```

#### 2. 使用go脚本一键root
```shell
git clone https://github.com/imcdd/hiwifi-ssh-launcher.git
go main.go
```
脚本会自动进行失败尝试，唯一缺点就是需要go的执行环境。

#### 3. 使用python脚本一键root
```shell
git clone https://github.com/idhyt/HiWiFi.OpenSSH.OpenWRT.git

╰─ python hiwifi.ssh.py -H 192.168.41.1
[+] uuid: 12345678-1234-5678-1234-123456789012
[+] local token: RDRFRTA3NEE123456789NzaCwxNTY0MjE3MT123456789/i2a1hZBWqmA123456789
[+] cloud token: yaELY8i123456789n9QXOtYw=
[+] Success: ssh port is 22
```
这个脚本不会进行失败重试。但我们只需要在失败的时候再次执行脚本即可。


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