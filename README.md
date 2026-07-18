# 广州大学校园网多 WAN 叠加

在 ImmortalWrt/OpenWrt 路由器上，将两个校园网有线接入口配置为独立 WAN，分别完成广州大学 EPortal 网页认证，再通过 mwan3 实现按连接负载均衡和链路级故障切换。

> 本方案不会把一个 TCP 连接拆到两条线路。多线程下载、测速工具和多个终端并发时可以叠加；单连接速度仍受单条线路限制。

## 已验证环境

- 路由器：Redmi Router AC2100
- SoC：MediaTek MT7621
- 系统：ImmortalWrt 23.05.4
- 认证：广州大学 EPortal 网页认证
- 多 WAN：mwan3 2.11.8
- 上联：物理 `wan` + 从 LAN 网桥移出的 `lan1`

其他 OpenWrt 设备也可以参考，但物理端口名称、LAN 网桥结构和性能上限可能不同。

上述环境已经完成从端口拆分、双线认证、mwan3 分流到掉线重登的全流程验证。本文可以作为该环境的完整部署记录，但不对所有路由器作“零改动即可部署”的承诺。其他设备或固件至少需要核对端口名、LAN 网桥、防火墙后端和软件包名称；EPortal 的接口或加密方式变化时，认证脚本也需要同步调整。

## 仓库内容

- [`luci-app-gzhu-eportal/`](luci-app-gzhu-eportal/)：可安装的 LuCI 插件，包含认证脚本、后台服务和图形配置页。
- [`luci-app-gzhu-eportal/root/usr/bin/eportal-login`](luci-app-gzhu-eportal/root/usr/bin/eportal-login)：按指定 WAN 检测联网状态、发现 Portal 并提交认证。
- [`luci-app-gzhu-eportal/root/etc/config/eportal`](luci-app-gzhu-eportal/root/etc/config/eportal)：双 WAN 账号配置模板。
- [`config/mwan3.example`](config/mwan3.example)：双线等权负载均衡及故障切换模板。

## 工作原理

```text
校园网口 A -> 物理 wan  -> 逻辑 wan  -> EPortal 认证 A --+
                                                        +-> mwan3 -> LAN/Wi-Fi
校园网口 B -> 物理 lan1 -> 逻辑 wan2 -> EPortal 认证 B --+
```

EPortal 重定向 URL 中的 `wlanuserip`、`mac`、`nasip` 等值是接入网关动态生成的密文。脚本不会写死这些参数，而是从每个 WAN 独立触发重定向，再把完整查询字符串提交给登录接口。

mwan3 通过 ICMP 跟踪地址判断链路是否可达，EPortal 登录状态则由认证脚本的 HTTP `204` 检查负责。若 Portal 永久拒绝认证但仍允许 ping，mwan3 仍可能显示该线路在线；这种情况需要根据认证日志处理账号或 Portal 问题，而不是把它当成物理链路故障。

截至 2026-07-18，页面返回 `passwordEncrypt=false`，登录接口为动态 Portal 地址下的：

```text
InterFace.do?method=login
```

校园网升级后若改为 RSA 加密，本脚本会登录失败，需要重新抓取浏览器请求并更新实现。

## 重要警告

1. 先通过 Wi-Fi 管理路由器。改动中的 LAN 口会暂时断开。
2. 不要在 LAN 网桥中直接插入第二条校园网线，否则可能把校园网 DHCP、广播或 IPv6 RA 引入内网。
3. 开始前备份配置，确认自己有串口、救砖或恢复固件的能力。
4. 账号密码会明文保存在路由器中，只能允许 root 读取。
5. 请遵守学校网络管理规定。本项目仅用于本人获授权的账号和设备。

## 开始之前

你需要准备：

- 两个可独立触发广州大学 EPortal 登录页的校园网有线接入口。
- 一台具有两个可用上联端口的 ImmortalWrt/OpenWrt 路由器。
- 路由器的 root SSH 权限，以及一台安装了 Git、SSH 和 SCP 的电脑。
- 两个允许同时在线的账号，或一个经实测允许建立两个会话的账号。

部署前建议把两条校园网线分别接到电脑或路由器原 WAN 口，访问一个普通 HTTP 页面，确认两条线路都能独立跳转到广州大学 EPortal。若某一条线路本身不能触发认证，先解决接入侧问题，不要继续配置 mwan3。

先在电脑上克隆仓库。后文标注“电脑执行”的命令均在这个仓库目录中运行；标注“路由器执行”的命令均在 SSH 会话中运行。

```sh
git clone https://github.com/Nubfall/gzhu-campus-multiwan.git
cd gzhu-campus-multiwan
```

示例中的路由器 LAN 地址是 `192.168.1.1`。如果你的管理地址不同，请替换全部对应地址。上传命令使用 `scp -O` 强制采用传统 SCP 协议，因为 OpenWrt 的 Dropbear 通常不提供现代 OpenSSH 默认使用的 SFTP 服务。

## 1. 备份路由器

电脑执行，SSH 登录路由器：

```sh
ssh root@192.168.1.1
```

路由器执行，创建系统配置备份：

```sh
stamp=$(date +%Y%m%d-%H%M%S)
sysupgrade -b "/root/router-config-before-multiwan-$stamp.tar.gz"
echo "/root/router-config-before-multiwan-$stamp.tar.gz"
```

记下输出的文件名，并在电脑执行以下命令将备份下载到本地：

```sh
scp -O root@192.168.1.1:/root/router-config-before-multiwan-YYYYMMDD-HHMMSS.tar.gz .
```

将示例时间替换为刚才的实际值。也可以在 LuCI 的“系统 -> 备份/升级”中直接生成并下载备份。`sysupgrade -b` 主要备份配置，不包含固件和软件包安装文件；完整刷机恢复时仍可能需要重新安装 mwan3、curl 和 Lua。

## 2. 将一个 LAN 口改为 WAN2

以下示例使用 `lan1`。路由器执行以下命令，先确认端口名称：

```sh
ip link show
uci show network
```

如果系统中已经存在名为 `wan2` 的接口，不要直接运行后面的 UCI 命令；请先换一个未占用的接口名，并同步修改配置模板和命令。

推荐通过 LuCI 操作：

1. 打开“网络 -> 接口 -> 设备”。
2. 编辑 `br-lan`，从网桥端口中移除 `lan1`。
3. 新建接口 `wan2`。
4. 协议选择“DHCP 客户端”。
5. 设备选择 `lan1`。
6. 为原 `wan` 设置网关跃点 `10`，`wan2` 设置为 `20`。
7. 将 `wan2` 加入现有 WAN 防火墙区域。
8. 保存并应用。

典型 UCI 操作如下。执行前必须确认自动找到的是正确节：

```sh
BR_SECTION=$(uci show network | sed -n "s/^\(network\.[^.]*\)\.name='br-lan'$/\1/p" | head -n 1)
WAN_ZONE=$(uci show firewall | sed -n "s/^\(firewall\.[^.]*\)\.name='wan'$/\1/p" | head -n 1)

echo "br-lan section: $BR_SECTION"
echo "wan zone: $WAN_ZONE"

[ -n "$BR_SECTION" ] || { echo '未找到 br-lan 设备节，停止修改' >&2; exit 1; }
[ -n "$WAN_ZONE" ] || { echo '未找到 wan 防火墙区域，停止修改' >&2; exit 1; }

uci del_list "$BR_SECTION.ports=lan1"
uci set network.wan.metric='10'
uci set network.wan2='interface'
uci set network.wan2.device='lan1'
uci set network.wan2.proto='dhcp'
uci set network.wan2.metric='20'
uci -q del_list "$WAN_ZONE.network=wan2"
uci add_list "$WAN_ZONE.network=wan2"
uci commit network
uci commit firewall
/etc/init.d/network reload
/etc/init.d/firewall restart
```

确认两条线都获得不同的 DHCP 地址：

```sh
ubus call network.interface.wan status
ubus call network.interface.wan2 status
ip -4 route
```

## 3. 安装 mwan3

路由器执行：

```sh
opkg update
opkg install mwan3 luci-app-mwan3
```

中文 LuCI 语言包是可选项；软件源提供时再安装：

```sh
opkg install luci-i18n-mwan3-zh-cn
```

路由器执行，备份原 mwan3 配置：

```sh
cp /etc/config/mwan3 "/root/mwan3.bak-$(date +%Y%m%d-%H%M%S)"
```

退出 SSH 后，在电脑的仓库目录执行：

```sh
scp -O config/mwan3.example root@192.168.1.1:/etc/config/mwan3
ssh root@192.168.1.1 'chmod 600 /etc/config/mwan3; /etc/init.d/mwan3 enable; /etc/init.d/mwan3 restart'
```

也可以在 LuCI 的“网络 -> MultiWAN 管理器”中按模板逐项创建。

路由器执行，检查状态：

```sh
mwan3 status
```

正常时应看到：

```text
interface wan is online
interface wan2 is online

balanced:
 wan2 (50%)
 wan (50%)
```

## 4. 部署 EPortal 自动认证

路由器执行，安装依赖：

```sh
opkg update
opkg install curl lua
```

电脑执行，上传脚本并运行自检：

```sh
scp -O luci-app-gzhu-eportal/root/usr/bin/eportal-login root@192.168.1.1:/usr/bin/eportal-login
ssh root@192.168.1.1 'chmod 700 /usr/bin/eportal-login; /usr/bin/eportal-login --self-test'
```

预期输出：

```text
self-test: ok
```

电脑执行，复制配置模板：

```sh
scp -O luci-app-gzhu-eportal/root/etc/config/eportal root@192.168.1.1:/etc/config/eportal
ssh root@192.168.1.1 'chmod 600 /etc/config/eportal'
```

路由器执行 `vi /etc/config/eportal`，替换以下占位符，并把需要认证的账号节中 `enabled` 改为 `1`：

```text
YOUR_ACCOUNT_A
YOUR_PASSWORD_A
YOUR_ACCOUNT_B_OR_ACCOUNT_A
YOUR_PASSWORD_B_OR_PASSWORD_A
```

`interface` 填的是实际出站设备，不一定等于 UCI 逻辑接口名。可以在路由器上查询：

```sh
ubus call network.interface.wan status | jsonfilter -e '@.l3_device'
ubus call network.interface.wan2 status | jsonfilter -e '@.l3_device'
```

本教程的实测值是：

- 原 WAN：通常是 `wan`
- 第二 WAN：本例是 `lan1`

如果学校允许同一账号多会话，两个节可以填写同一账号；否则填写两个账号。

路由器执行，手动测试：

```sh
/usr/bin/eportal-login wan
/usr/bin/eportal-login wan2
```

脚本以 HTTP `204` 作为真正在线依据。校园网认证前可能允许 ICMP，所以仅能 ping 通公网不代表认证成功。

查看日志：

```sh
logread -e eportal-login
```

## 5. 设置掉线重登

路由器执行，先备份现有 cron：

```sh
cp /etc/crontabs/root "/root/crontab-root.bak-$(date +%Y%m%d-%H%M%S)"
```

删除旧的同类任务后再添加，重复执行这一段也不会产生重复条目：

```sh
sed -i '\|/usr/bin/eportal-login|d' /etc/crontabs/root
printf '%s\n' \
  '*/2 * * * * /usr/bin/eportal-login wan' \
  '*/2 * * * * /usr/bin/eportal-login wan2' >> /etc/crontabs/root
/etc/init.d/cron enable
/etc/init.d/cron restart
```

两条任务彼此独立；即使一条认证失败，另一条仍会继续检查。脚本带有按接口区分的运行锁，前一次检查尚未结束时不会在同一接口重复运行。

## 6. 验证双线认证

路由器执行，分别绑定实际出站设备检查：

```sh
curl --interface wan  -sS -o /dev/null -w '%{http_code}\n' http://connectivitycheck.gstatic.com/generate_204
curl --interface lan1 -sS -o /dev/null -w '%{http_code}\n' http://connectivitycheck.gstatic.com/generate_204
```

两条都应返回：

```text
204
```

查看 mwan3 实际分配计数：

```sh
iptables -t mangle -L mwan3_policy_balanced -v -n --line-numbers
```

两个 MARK 规则的计数都持续增加，说明两条线路都在承载新连接。

至此满足以下三项才算部署完成：两次绑定设备的 HTTP 检查都返回 `204`；`mwan3 status` 显示 `wan` 和 `wan2` 在线；多连接下载或测速时两个策略计数都增长。只满足 ping 或 mwan3 在线不足以证明 Portal 认证成功。

## 7. 波动优化

### 不要启用全局 HTTPS 粘滞

mwan3 示例经常包含：

```text
option sticky '1'
```

在当前 mwan3 版本中，这会把一台客户端的全部 HTTPS 流量固定到某一 WAN，默认约 600 秒。超时后重新选择出口，容易表现为测速忽快忽慢，也无法稳定叠加同一客户端的多连接下载。

本仓库的 `mwan3.example` 已移除该项。每个 TCP 连接仍由 conntrack 固定在创建时的出口，不会在连接中途切线。

两条 WAN 可能具有不同公网 IP。去掉粘滞后，少数严格绑定来源 IP 的网站可能要求重新登录。遇到这类站点，应为其建立 `wan_only` 规则，而不是重新开启全局粘滞。

### 流量卸载

在 MT7621 上，关闭全部流量卸载通常更稳定，但吞吐会明显下降。实测折中或关闭方案没有保留足够性能，因此最终继续开启软件和硬件卸载：

```sh
uci set firewall.@defaults[0].flow_offloading='1'
uci set firewall.@defaults[0].flow_offloading_hw='1'
uci commit firewall
/etc/init.d/firewall restart
/etc/init.d/mwan3 restart
```

其他芯片若出现错误出口、连接卡死或 mwan3 计数异常，应 A/B 测试关闭硬件卸载：

```sh
uci set firewall.@defaults[0].flow_offloading_hw='0'
uci commit firewall
/etc/init.d/firewall restart
```

### 理解随机分配

mwan3 对新连接按概率分配，不是严格轮流：

- 2 个连接可能恰好都走同一条 WAN。
- 4 个连接常出现 3:1。
- 并发连接越多，越接近 50:50。
- 单个 TCP/QUIC 连接永远不会叠加。

需要真正稳定地合并单连接时，应使用 OpenMPTCProuter、Speedify 或其他带远端聚合服务器的方案，而不是继续堆 mwan3 规则。

## 8. 故障排查

### WAN2 有 IP，但 curl 无法绑定出口

两个校园网 WAN 可能处于同一网段并使用同一个网关。mwan3 建表后，本机发出的绑定接口请求还需要对应的 `oif` 规则。认证脚本会从 mwan3 的 `iif` 规则自动找到路由表，并补充优先级 100 的 `oif` 规则。

检查：

```sh
ip -4 rule
ip -4 route show table 1
ip -4 route show table 2
```

### mwan3 显示在线，但网页未认证

校园网可能在认证前放行 ping，因此 mwan3 的 ICMP 跟踪只能判断链路，不能判断 Portal 状态。以脚本的 HTTP `204` 检查为准。

### Portal 返回登录失败

1. 确认账号密码没有多余空格。
2. 确认请求确实绑定到正确物理设备。
3. 重新访问 `http://connectivitycheck.gstatic.com/generate_204` 等普通 HTTP 地址，检查 Portal 页面是否仍返回 `passwordEncrypt=false`。
4. 使用浏览器开发者工具抓取一次成功登录请求，对照字段。

### 查看运行日志

```sh
logread -e eportal-login
logread -e mwan3
mwan3 status
```

## 9. 回滚

只撤销自动认证：

```sh
sed -i '\|/usr/bin/eportal-login|d' /etc/crontabs/root
/etc/init.d/cron restart
rm -f /usr/bin/eportal-login /etc/config/eportal
```

撤销 mwan3：

```sh
/etc/init.d/mwan3 stop
/etc/init.d/mwan3 disable
opkg remove luci-i18n-mwan3-zh-cn luci-app-mwan3 mwan3
```

完整恢复：

```sh
sysupgrade -r /root/router-config-before-multiwan-YYYYMMDD-HHMMSS.tar.gz
reboot
```

也可以在 LuCI 的“系统 -> 备份/升级”中上传备份恢复。若恢复前重刷过固件，还需要按第 3、4 节重新安装依赖和部署脚本。

## 10. 安装 LuCI 插件

插件适用于 ImmortalWrt/OpenWrt 23.05 系列。仓库中的 [`luci-app-gzhu-eportal_0.1.4_all.ipk`](dist/luci-app-gzhu-eportal_0.1.4_all.ipk) 已使用 ImmortalWrt 23.05.4 `ramips/mt7621` SDK 完成真实构建，包架构为 `all`。

电脑执行上传，随后在路由器安装：

```sh
scp -O dist/luci-app-gzhu-eportal_0.1.4_all.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg update; opkg install /tmp/luci-app-gzhu-eportal_0.1.4_all.ipk; /etc/init.d/gzhu-eportal enable; /etc/init.d/gzhu-eportal start'
```

安装后打开“网络 -> 广州大学校园网认证”。账号、密码、验证网址和端口绑定都可以在页面中修改；“检查并认证全部线路”和“查看日志”用于现场排查。mwan3 的成员、策略、权重和跟踪参数仍在“网络 -> MultiWAN 管理器”中调整。

插件页面可调整：每条线路的启用状态、名称、实际出站设备、账号、密码、Portal 服务字段和路由表；全局的验证网址、成功状态码、检查周期、探测/登录超时、登录重试次数、登录接口路径和出站规则优先级。动态的 `wlanuserip`、`mac`、`nasip`、`queryString` 仍由脚本自动发现，不应手工固定。

`/etc/config/eportal` 已声明为 opkg 配置文件，升级插件时会保留现有账号设置。首次安装会将其权限收紧为 `600`。
安装脚本会删除旧版手动配置留下的 `/usr/bin/eportal-login` cron 任务，改由 procd 服务统一调度。

### 自行构建

需要在 Linux、WSL 或 ImmortalWrt SDK 中构建，路由器本身不建议承担编译工作。

在 SDK 根目录执行：

```sh
cp -a /path/to/gzhu-campus-multiwan/luci-app-gzhu-eportal package/
./scripts/feeds update base packages luci routing
./scripts/feeds install curl lua mwan3 luci-base
make defconfig
make package/luci-app-gzhu-eportal/compile V=s
find bin/packages -name 'luci-app-gzhu-eportal_*.ipk'
```

在电脑上把生成的 IPK 上传到路由器，再执行安装：

```sh
scp -O bin/packages/*/*/luci-app-gzhu-eportal_*.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg update; opkg install /tmp/luci-app-gzhu-eportal_*.ipk; /etc/init.d/gzhu-eportal enable; /etc/init.d/gzhu-eportal start'
```

如果只想使用命令行，仍可按第 4、5 节直接上传插件目录中的脚本和配置模板。

## License

[MIT](LICENSE)
