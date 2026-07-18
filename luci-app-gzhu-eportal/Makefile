include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Guangzhou University EPortal
LUCI_DEPENDS:=+curl +lua +mwan3
LUCI_PKGARCH:=all
PKG_VERSION:=0.1.3
PKG_RELEASE:=1
PKG_LICENSE:=MIT

define Package/luci-app-gzhu-eportal/conffiles
/etc/config/eportal
endef

define Package/luci-app-gzhu-eportal/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	chmod 600 /etc/config/eportal
	[ -f /etc/crontabs/root ] && sed -i '\|/usr/bin/eportal-login|d' /etc/crontabs/root
	/etc/init.d/cron restart 2>/dev/null || true
	/etc/init.d/gzhu-eportal enable
	/etc/init.d/gzhu-eportal restart
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
