'use strict';
'require form';
'require fs';
'require poll';
'require ui';
'require uci';
'require view';
'require tools.widgets as widgets';

var statusData = { accounts: [] };
var readonly = !L.hasViewPermission();

function statusText(state) {
	return {
		online: _('在线'),
		disabled: _('未启用'),
		rejected: _('认证被拒绝'),
		error: _('错误'),
		misconfigured: _('配置不完整'),
		never: _('尚未运行')
	}[state] || state || _('未知');
}

function statusClass(state) {
	return state === 'online' ? 'success' : state === 'disabled' || state === 'never' ? 'warning' : 'danger';
}

function parseStatus(result) {
	try {
		return JSON.parse(result.stdout || '{"accounts":[]}');
	} catch (e) {
		return { accounts: [] };
	}
}

function renderStatus(data) {
	var rows = (data.accounts || []).map(function(account) {
		var when = account.timestamp ? new Date(account.timestamp * 1000).toLocaleString() : _('尚未运行');
		return [
			account.label || account.section,
			account.interface || '-',
			E('span', { 'class': 'badge ' + statusClass(account.state) }, [ statusText(account.state) ]),
			account.code || '-',
			account.message || '-',
			when
		];
	});

	var table = E('table', { 'class': 'table cbi-section-table' }, [
		E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, [ _('线路') ]),
			E('th', { 'class': 'th' }, [ _('绑定设备') ]),
			E('th', { 'class': 'th' }, [ _('状态') ]),
			E('th', { 'class': 'th' }, [ _('HTTP') ]),
			E('th', { 'class': 'th' }, [ _('说明') ]),
			E('th', { 'class': 'th' }, [ _('最后检查') ])
		])
	]);

	cbi_update_table(table, rows, E('em', [ _('暂无认证线路配置') ]));
	return table;
}

function refreshStatus() {
	return fs.exec('/usr/bin/eportal-status').then(function(result) {
		statusData = parseStatus(result);
		var node = document.getElementById('gzhu-eportal-status');
		if (node)
			node.replaceChildren(renderStatus(statusData));
	});
}

function showLogs() {
	return fs.exec('/sbin/logread', [ '-e', 'eportal-login' ]).then(function(result) {
		ui.showModal(_('认证日志'), [
			E('pre', { 'style': 'max-height: 60vh; overflow: auto; white-space: pre-wrap' }, [ result.stdout || _('暂无日志') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('关闭') ])
			])
		]);
	}).catch(function(error) {
		ui.addNotification(null, E('p', [ error.message ]));
	});
}

function runAll() {
	ui.showModal(_('正在认证'), [ E('p', { 'class': 'spinning' }, [ _('正在检查所有启用线路，请稍候…') ]) ]);
	return fs.exec('/usr/bin/eportal-watchdog', [ '--once' ]).then(function(result) {
		if (result.code)
			ui.addNotification(null, E('p', [ _('部分线路认证失败，请查看状态和日志。') ]), 'warning');
	}).catch(function(error) {
		ui.addNotification(null, E('p', [ error.message ]));
	}).finally(function() {
		ui.hideModal();
		return refreshStatus();
	});
}

function runAccount(section) {
	return fs.exec('/usr/bin/eportal-login', [ section ]).then(function(result) {
		if (result.code)
			ui.addNotification(null, E('p', [ _('认证失败，请查看状态和日志。') ]), 'warning');
		else
			ui.addNotification(null, E('p', [ _('认证检查已完成。') ]));
	}).catch(function(error) {
		ui.addNotification(null, E('p', [ error.message ]));
	}).finally(refreshStatus);
}

return view.extend({
	load: function() {
		return fs.exec('/usr/bin/eportal-status').then(function(result) {
			statusData = parseStatus(result);
			return uci.load('eportal');
		});
	},

	render: function() {
		var m, s, o;

		m = new form.Map('eportal', _('广州大学校园网认证'),
			_('分别为每条校园网线路完成 EPortal 认证。验证网址和账号密码只保存在路由器本地。'));

		s = m.section(form.NamedSection, 'globals', 'globals', _('认证设置'));
		s.anonymous = true;
		s.addremove = false;
		s.tab('basic', _('基本设置'));
		s.tab('advanced', _('高级设置'));

		o = s.taboption('basic', form.Value, 'check_url', _('验证网址'), _('访问该地址时会触发 Portal 检测。'));
		o.datatype = 'url';
		o.rmempty = false;

		o = s.taboption('basic', form.Value, 'expected_code', _('成功状态码'));
		o.datatype = 'range(100, 599)';
		o.default = '204';

		o = s.taboption('basic', form.Value, 'check_interval', _('检查周期（秒）'));
		o.datatype = 'range(30, 3600)';
		o.default = '120';

		o = s.taboption('advanced', form.Value, 'detect_timeout', _('Portal 探测超时（秒）'));
		o.datatype = 'range(1, 120)';
		o.default = '15';

		o = s.taboption('advanced', form.Value, 'login_timeout', _('登录请求超时（秒）'));
		o.datatype = 'range(1, 120)';
		o.default = '20';

		o = s.taboption('advanced', form.Value, 'verify_delay', _('登录后验证等待（秒）'));
		o.datatype = 'range(1, 30)';
		o.default = '2';

		o = s.taboption('advanced', form.Value, 'retry_count', _('登录尝试次数'));
		o.datatype = 'range(1, 5)';
		o.default = '1';

		o = s.taboption('advanced', form.Value, 'login_path', _('登录接口路径'));
		o.default = 'InterFace.do?method=login';
		o.validate = function(section, value) {
			return value && /^[A-Za-z0-9_./?=&-]+$/.test(value) ? true : _('登录接口路径包含不支持的字符。');
		};

		o = s.taboption('advanced', form.Value, 'rule_priority', _('出站规则优先级'));
		o.datatype = 'range(1, 32765)';
		o.default = '100';

		s = m.section(form.GridSection, 'account', _('认证线路'));
		s.anonymous = false;
		s.addremove = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'label', _('名称'));
		o.rmempty = false;
		o.validate = function(section, value) {
			return value && !/[|\r\n]/.test(value) ? true : _('名称不能为空，且不能包含换行或竖线。');
		};

		o = s.option(widgets.DeviceSelect, 'interface', _('绑定设备'));
		o.noaliases = true;
		o.nobridges = false;
		o.noinactive = false;
		o.nocreate = false;
		o.rmempty = false;

		o = s.option(form.Value, 'username', _('账号'));
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'password', _('密码'));
		o.password = true;
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'service', _('Portal 服务字段'));
		o.modalonly = true;
		o.optional = true;

		o = s.option(form.Value, 'route_table', _('路由表（可选）'), _('留空时自动从 mwan3 规则发现。'));
		o.datatype = 'uciname';
		o.modalonly = true;
		o.optional = true;

		o = s.option(form.Button, '_login', _('操作'));
		o.inputstyle = 'apply';
		o.textvalue = function() { return _('立即认证'); };
		o.readonly = readonly;
		o.onclick = runAccount;

		return Promise.resolve(m.render()).then(function(map) {
			var status = E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' }, [ _('状态由后台认证服务定期更新；mwan3 的权重和策略请在 MultiWAN 管理器中调整。') ]),
				E('div', { 'class': 'left' }, [
					E('button', { 'class': 'btn cbi-button-action', 'click': runAll, 'disabled': readonly || null }, [ _('立即认证全部线路') ]),
					' ',
					E('button', { 'class': 'btn', 'click': showLogs }, [ _('查看日志') ])
				]),
				E('div', { 'id': 'gzhu-eportal-status', 'style': 'margin-top: 1em' }, [ renderStatus(statusData) ])
			]);

			poll.add(refreshStatus, 15);
			return E([], [ status, map ]);
		});
	},

	handleSaveApply: function(ev, mode) {
		var restart = function() {
			document.removeEventListener('uci-applied', restart);
			fs.exec('/etc/init.d/gzhu-eportal', [ 'restart' ]);
		};
		document.addEventListener('uci-applied', restart);
		return this.super('handleSaveApply', [ ev, mode ]);
	}
});
