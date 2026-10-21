(() => {
  const $ = id => document.getElementById(id);
  const fromURL = location.hash.slice(1);
  if (fromURL) { sessionStorage.setItem('studioConsoleToken', fromURL); history.replaceState(null, '', '/'); }
  const token = sessionStorage.getItem('studioConsoleToken') || '';
  const names = { start: '启动服务', stop: '停止服务', restart: '重启服务', save: '保存代理', apply: '保存并应用', admin: '打开管理页' };
  const sources = { saved: '后端保存的配置', option: '旧进程的插件覆盖', env: '旧进程的环境覆盖', startup: '旧进程启动时的配置', unknown: '暂不能确认', system: '系统自动检测', direct: '直连' };
  let lastState;
  let reading = false;
  let sending = false;
  let dirty = false;
  let submittedID;

  function show(text, error = false) { $('message').textContent = text; $('message').dataset.error = String(error); }
  async function request(route, body) {
    if (!token) throw new Error('没有控制台访问凭证，请从 Magpie 重新打开。');
    const response = await fetch(`/api/${route}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'error'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `本机控制台返回 ${response.status}`);
    return result;
  }
  function buttons(disabled) {
    document.querySelectorAll('button:not(#refresh), #proxy-url').forEach(element => { element.disabled = disabled; });
    if (!disabled) {
      $('start').disabled = lastState?.backend.status === 'running' && !lastState?.paused;
      $('admin').disabled = lastState?.backend.status !== 'running';
    }
  }
  function render(state) {
    lastState = state;
    if (state.operation?.state === 'done' && state.operation.id === submittedID && ['save', 'apply'].includes(state.operation.action)) dirty = false;
    const backend = state.backend;
    $('connection').textContent = '已连接本机';
    $('application-state').textContent = state.applicationBound ? '状态每 3 秒刷新。关闭此页面不停止后端；退出 Magpie 桌面应用后会关闭本机后端与控制台。' : '状态每 3 秒刷新。尚未绑定 Magpie 桌面应用，退出联动未启用；可在此手动停止服务。';
    $('backend').textContent = ({ running: '运行中', stopped: '已停止', not_installed: '未安装', foreign: '端口冲突', unresponsive: '无响应', outdated: '版本待更新', version_conflict: '版本冲突' })[backend.status] || backend.status;
    $('generation').textContent = backend.ready ? '已就绪' : backend.status !== 'running' ? '未运行' : backend.running ? '准备中' : '未就绪';
    $('accounts').textContent = `${backend.accounts.ready} 可用 / ${backend.accounts.total} 总计 · ${backend.accounts.busy} 使用中`;
    $('pause-state').textContent = state.paused ? '自动启动已暂停。Magpie 请求与刷新不会重新拉起后端。' : '打开 Magpie 时自动启动已配置的后端；本控制台的状态刷新不会启动后端。';
    $('active-proxy').textContent = state.proxy ? (state.proxy.active || '直连') : backend.status === 'running' ? '读取失败，不能判断' : '后端未运行';
    $('proxy-source').textContent = state.proxy ? sources[state.proxy.source] || state.proxy.source : '—';
    $('saved-proxy').textContent = state.savedDisplay || '自动检测系统代理';
    $('applied').textContent = state.proxy?.pending ? '待应用，需重启后端' : state.proxy ? '已与运行时核对' : '运行时未核对';
    if (!dirty && document.activeElement !== $('proxy-url')) {
      $('proxy-url').value = state.savedProxy ?? '';
      $('proxy-url').placeholder = state.containsPassword ? '已保存含密码的代理；修改时请输入完整新地址' : 'http://127.0.0.1:7890';
    }
    const operation = state.operation;
    if (operation?.state === 'running') show(`${names[operation.action]}：正在处理，请稍候。`);
    else if (operation && (!submittedID || operation.id === submittedID)) {
      show(operation.state === 'failed' ? `${names[operation.action]}失败：${operation.message}` : `${names[operation.action]}已完成。${operation.action === 'save' ? '仅保存了配置，尚未重启后端。' : ''}`, operation.state === 'failed');
    } else if (!submittedID) show(state.proxyError || backend.reason || '状态已更新。');
    buttons(sending || operation?.state === 'running');
  }
  async function refresh() {
    if (reading) return;
    reading = true;
    try { render(await request('state')); }
    catch (error) { $('connection').textContent = '连接失败'; buttons(true); show(error.message, true); }
    finally { reading = false; }
  }
  async function action(name) {
    if (sending || lastState?.operation?.state === 'running') return;
    const body = {};
    if (name === 'save' || name === 'apply') {
      if (lastState?.containsPassword && !dirty) { show('已保存的地址包含密码。请填写完整新地址后保存；若只是重新应用原配置，请点击“重启服务”。', true); return; }
      body.proxy = $('proxy-url').value;
    }
    if (['stop', 'restart', 'apply'].includes(name)) {
      if (!confirm(`${names[name]}会中断未完成的请求。是否继续？`)) return;
      body.confirm = true;
    }
    sending = true;
    buttons(true);
    show(`${names[name]}：正在提交。`);
    let failure;
    try {
      const result = await request(name, body);
      submittedID = result.operation.id;
      show(`${names[name]}：请求已接受，正在处理。`);
    } catch (error) { failure = error.message; }
    finally { sending = false; await refresh(); if (failure) show(failure, true); }
  }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action)));
  $('save').addEventListener('click', () => action('save'));
  $('apply').addEventListener('click', () => action('apply'));
  $('refresh').addEventListener('click', refresh);
  $('proxy-url').addEventListener('input', () => { dirty = true; });
  $('proxy-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); action('save'); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
})();
