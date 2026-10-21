(async () => {
  const button = document.getElementById('open');
  const message = document.getElementById('message');
  try {
    if (!globalThis.magpie) throw new Error('请从 Magpie 中打开此入口。');
    await magpie.ready;
    button.disabled = false;
    message.textContent = '点击后将通过系统默认浏览器打开本机控制台。';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const options = (await magpie.options.get()) ?? {};
        if (typeof options !== 'object' || Array.isArray(options) || (options.studio && (typeof options.studio !== 'object' || Array.isArray(options.studio)))) {
          throw new Error('插件选项格式异常，未覆盖原配置。');
        }
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
        await magpie.options.set({ ...options, studio: { ...options.studio, localConsole: true, consoleOpen: { id, at: Date.now() } } });
        message.textContent = '打开请求已提交。若浏览器没有出现，请检查默认浏览器设置和本机数据目录中的 console.log。';
      } catch (error) {
        message.textContent = error.message || '无法提交打开请求，请重试。';
      } finally {
        setTimeout(() => { button.disabled = false; }, 1500);
      }
    });
  } catch (error) { message.textContent = error.message || '无法连接 Magpie。'; }
})();
