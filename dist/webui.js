/**
 * 动画工作台「控制台」面板（浏览器端 bundle）。
 *
 * 手写 ESM，不导入任何模块：服务端按 `cortico.webUiClient` 定位本文件，浏览器直接
 * `import()`，默认导出必须为 `{ panels: { <panelId>: { mount(ctx) } } }`。
 * 外观统一使用宿主提供的 `ctx.ui` 原语，深浅主题、字号与圆角与控制台其它页面保持一致。
 *
 * 数据面全部经 `ctx.invoke` → `World.webUi().invoke`，复用工具层实现，不维护第二套状态。
 * 框架另按 `webUi().config` 自动渲染「配置」页签；本面板提供常用配置项，以及工程安装、
 * 服务启停、日志查看等需由用户直接触发的操作。
 *
 * 面板顺序：运行状态 → 常用配置 → 操作 → 运行日志。
 * 操作区用 `ui.section` 划分「服务」「工程」两组，各组附说明；低频辅助动作按用途归位。
 * 工程组显示当前版本与最新版本；须经「检查更新」确认存在新版本后，「更新工程」方可执行；
 * 「安装工程」不受该限制。服务来源区分「本实例启动」与「上一次 Core 启动后已接管」，后者同样可终止。
 */

const TEXT = {
  zh: {
    noUi: '当前 WebUI 未提供面板原语，请在「配置」页签中完成设置。',
    statusTitle: '运行状态',
    statusDesc: '每 6 秒自动刷新。服务端口取自当前配置，并非固定值 4380。',
    service: '服务', online: '在线', offline: '未启动', building: '构建中（可能耗时数分钟）',
    autoBuild: '启动前自动构建', buildOn: '启用（默认）', buildOff: '关闭',
    source: '来源', owned: '本扩展启动', external: '外部服务（本扩展不会终止）', none: '无',
    ownedAdopted: '上一次 Core 启动的进程，已接管（可终止）',
    port: '端口', address: 'MCP 端点', project: '工程目录', version: '工程版本',
    deps: '依赖', installed: '已安装', missing: '未安装（请先安装或更新工程）',
    registry: '下载源', envOverride: '环境变量覆盖',

    configTitle: '常用配置',
    configDesc: '此处提供常用配置项，完整配置项位于「配置」页签。保存后立即生效；工程目录留空时使用默认路径，修改端口将同步更新服务地址与 MCP 端点。',
    portField: '服务端口', registryField: 'npm 下载源', dirField: '工程目录',
    autoBuildField: '启动前自动构建前端', autoStartField: '工具调用时自动启动服务',
    autoStartHint: '默认关闭。工具调用不会在后台启动服务；启用后，模型调用工具时将自动启动服务。',
    save: '保存配置', saved: '已保存', nowPort: '当前端口',

    actionsTitle: '操作',
    actionsDesc: '操作按用途分组。涉及文件写入的操作将先行确认；当前不可用的按钮以禁用状态显示。',
    secService: '服务',
    secServiceDesc: '启动或停止由本扩展管理的服务，或打开当前端口对应的编辑器。',
    secProject: '工程',
    secProjectDesc: '显示当前版本与最新版本。检测到新版本后，「更新工程」方可执行；首次安装不受此限制。',
    start: '启动服务', stop: '停止服务', open: '打开编辑器',
    startTitle: '按当前配置启动；默认先执行 prebuild 与 build，构建失败将中止启动',
    stopTitle: '终止由本扩展启动或已接管的服务',
    openTitle: '在浏览器中打开当前端口对应的编辑器',
    startWhy: '服务已在运行，无需重复启动',
    stopWhy: '仅由本扩展启动或已接管的服务可终止；外部服务不受影响',
    openWhy: '服务未启动，编辑器暂不可用',
    skipBuild: '跳过构建',
    skipBuildHint: '勾选后，启动服务将不执行 prebuild 与 build；仅适用于源码未变更的场景。',
    install: '安装工程', update: '更新工程',
    installTitle: '下载工程、按合并规则落地并安装依赖',
    updateTitle: '下载新版本、覆盖代码文件并重新安装依赖',
    check: '检查更新', checkTitle: '只读查询下载源的最新版本，不修改任何文件',
    updateWhy: '须先执行「检查更新」，确认存在新版本后方可更新',
    curVersion: '当前版本', latestVersion: '最新版本', verStatus: '状态',
    notChecked: '未检查', upToDate: '已是最新版本', newAvailable: '发现新版本',
    checkFailed: '检查失败', notInstalled: '工程未安装',
    result: '完整输出', resultTitle: '查看最近一次操作的完整回执',
    clearLog: '清空显示', clearLogTitle: '仅清空面板显示，不删除服务端日志',
    running: '执行中', done: '已完成', failed: '失败',
    confirmInstall: '将从下载源获取工程、按合并规则落地并安装依赖，可能耗时数分钟。工程数据与用户自行安装的插件将保留。是否继续？',
    confirmUpdate: '将下载新版本、覆盖代码文件并重新安装依赖。data/、node_modules/、dist/ 与用户自行安装的插件将保留。是否继续？',

    logsTitle: '运行日志',
    logsDesc: '按来源分流，每 3 秒读取一次增量。最近一次操作的完整回执位于「操作」→「完整输出」。',
    logsEmpty: '暂无日志。启动服务或安装工程后将在此显示。',
  },
  en: {
    noUi: 'This WebUI does not expose panel primitives. Please use the Config tab.',
    statusTitle: 'Status',
    statusDesc: 'Refreshes every 6 seconds. The service port follows the current configuration and is not fixed at 4380.',
    service: 'Service', online: 'Online', offline: 'Not running', building: 'Building (may take several minutes)',
    autoBuild: 'Build before start', buildOn: 'On (default)', buildOff: 'Off',
    source: 'Source', owned: 'Started by this extension', external: 'External service (not terminated by this extension)', none: 'None',
    ownedAdopted: 'Left by a previous Core, adopted (can be terminated)',
    port: 'Port', address: 'MCP endpoint', project: 'Project directory', version: 'Project version',
    deps: 'Dependencies', installed: 'Installed', missing: 'Not installed (install or update the project first)',
    registry: 'Registry', envOverride: 'Environment override',

    configTitle: 'Common settings',
    configDesc: 'Common settings are provided here; the full set is available on the Config tab. Changes take effect on save. An empty project directory uses the default path, and changing the port updates both the service address and the MCP endpoint.',
    portField: 'Service port', registryField: 'npm registry', dirField: 'Project directory',
    autoBuildField: 'Build frontend before start', autoStartField: 'Auto-start service on tool calls',
    autoStartHint: 'Off by default. Tool calls do not start the service in the background. When enabled, a tool call starts the service automatically.',
    save: 'Save', saved: 'Saved', nowPort: 'Current port',

    actionsTitle: 'Actions',
    actionsDesc: 'Actions are grouped by purpose. Operations that write files require confirmation; unavailable actions are disabled.',
    secService: 'Service',
    secServiceDesc: 'Start or stop the service managed by this extension, or open the editor on the current port.',
    secProject: 'Project',
    secProjectDesc: 'Shows the current and latest versions. Update becomes available only after a newer version is detected; a first install is never blocked.',
    start: 'Start', stop: 'Stop', open: 'Open editor',
    startTitle: 'Start with the current configuration; prebuild and build run first, and a failed build aborts startup',
    stopTitle: 'Terminate the service started or adopted by this extension',
    openTitle: 'Open the editor on the current port in a browser',
    startWhy: 'The service is already running; starting again is unnecessary',
    stopWhy: 'Only services started or adopted by this extension can be terminated; external services are unaffected',
    openWhy: 'The service is not running; the editor is unavailable',
    skipBuild: 'Skip build',
    skipBuildHint: 'When checked, startup does not run prebuild and build. Use only when sources are unchanged.',
    install: 'Install project', update: 'Update project',
    installTitle: 'Download the project, merge files and install dependencies',
    updateTitle: 'Download a new version, overwrite code files and reinstall dependencies',
    check: 'Check updates', checkTitle: 'Read-only lookup of the latest version on the registry; no files are modified',
    updateWhy: 'Run Check updates first; Update becomes available only when a newer version exists',
    curVersion: 'Current', latestVersion: 'Latest', verStatus: 'Status',
    notChecked: 'Not checked', upToDate: 'Up to date', newAvailable: 'New version available',
    checkFailed: 'Check failed', notInstalled: 'Project not installed',
    result: 'Full output', resultTitle: 'Show the complete result of the last operation',
    clearLog: 'Clear view', clearLogTitle: 'Clears only the panel view; server-side logs are retained',
    running: 'Running', done: 'Completed', failed: 'Failed',
    confirmInstall: 'Downloads the project, merges files and installs dependencies. This may take several minutes. Project data and user-installed plugins are retained. Continue?',
    confirmUpdate: 'Downloads a new version, overwrites code files and reinstalls dependencies. data/, node_modules/, dist/ and user-installed plugins are retained. Continue?',

    logsTitle: 'Logs',
    logsDesc: 'Split by source, polls every 3 seconds. The complete result of the last operation is under Actions → Full output.',
    logsEmpty: 'No logs yet. Start the service or install the project to see entries here.',
  },
};

const pick = (language) => (language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en);
const oneLine = (text) => String(text ?? '').split('\n').find((line) => line.trim())?.slice(0, 180) ?? '';
const message = (error) => error?.message ?? String(error ?? '');

function setMsg(node, text, bad) {
  node.textContent = text;
  if (bad) node.classList.add('bad');
  else node.classList.remove('bad');
}

function mount(ctx) {
  const t = pick(ctx.language);
  const ui = ctx.ui;
  if (!ui) { ctx.root.textContent = t.noUi; return; }

  const btn = (label, onClick, variant = 'plain') => ui.button(label, { variant, size: 'sm', onClick });

  /* ── 运行状态 ── */
  const statusSheet = ui.sheet({ title: t.statusTitle, desc: t.statusDesc });
  ctx.root.appendChild(statusSheet.el);

  /* ── 常用配置（排在操作之前：先定端口/工程目录，再点动作） ── */
  const configSheet = ui.sheet({ title: t.configTitle, desc: t.configDesc });
  ctx.root.appendChild(configSheet.el);
  const portInput = ui.input({ type: 'number', value: '4380', cls: 'mono' });
  const registryInput = ui.input({ value: '', cls: 'mono' });
  const dirInput = ui.input({ value: '', cls: 'mono' });
  const autoBuildCb = ui.checkbox(t.autoBuildField, { checked: true });
  const autoStartCb = ui.checkbox(t.autoStartField, { checked: false, title: t.autoStartHint });
  configSheet.body.appendChild(ui.field(t.portField, portInput));
  configSheet.body.appendChild(ui.field(t.registryField, registryInput));
  configSheet.body.appendChild(ui.field(t.dirField, dirInput));
  /**
   * `label.check` 是 inline-flex 且不带外边距（styles.css 的 `label.check` 规则），
   * 上面几个输入框之所以有间距，是因为 `ui.field()` 生成的是带 `margin:14px 0 0` 的 `.fieldrow`。
   * 两个复选框直接挂到 `sheetbody` 会并排贴在同一行，因此统一放进一个纵向容器：
   * 顶部间距与 `.fieldrow` 对齐，两项之间 10px。
   */
  const checkStack = ui.h('div');
  checkStack.style.display = 'flex';
  checkStack.style.flexDirection = 'column';
  checkStack.style.gap = '10px';
  checkStack.style.marginTop = '14px';
  checkStack.appendChild(autoBuildCb.el);
  checkStack.appendChild(autoStartCb.el);
  configSheet.body.appendChild(checkStack);
  const configBar = ui.actions();
  configSheet.body.appendChild(configBar);
  const cfgMsg = ui.msgline();
  configSheet.body.appendChild(cfgMsg);
  const saveBtn = btn(t.save, () => { void saveConfig(); }, 'primary');
  configBar.appendChild(saveBtn);

  /* ── 操作：两组，各一句说明，主按钮只有 4 个 ── */
  const actionSheet = ui.sheet({ title: t.actionsTitle, desc: t.actionsDesc });
  ctx.root.appendChild(actionSheet.el);

  actionSheet.body.appendChild(ui.section(t.secService, t.secServiceDesc));
  const serviceBar = ui.actions();
  actionSheet.body.appendChild(serviceBar);
  const skipBuildCb = ui.checkbox(t.skipBuild, { checked: false, title: t.skipBuildHint });
  const startBtn = btn(t.start, () => {
    void runAction(t.start, 'service', ['start', skipBuildCb.checked ? { build: false } : {}]);
  }, 'primary');
  const stopBtn = btn(t.stop, () => { void runAction(t.stop, 'service', ['stop', {}]); }, 'danger');
  const openBtn = btn(t.open, () => { void runAction(t.open, 'service', ['open', {}]); });
  serviceBar.appendChild(startBtn);
  serviceBar.appendChild(stopBtn);
  serviceBar.appendChild(openBtn);
  serviceBar.appendChild(skipBuildCb.el);

  actionSheet.body.appendChild(ui.section(t.secProject, t.secProjectDesc));
  const versionBox = ui.rowbar();
  actionSheet.body.appendChild(versionBox);
  const projectBar = ui.actions();
  actionSheet.body.appendChild(projectBar);
  const checkBtn = btn(t.check, () => { void checkForUpdates(); });
  checkBtn.title = t.checkTitle;
  const projectBtn = btn(t.install, () => {
    const ready = projectReady;
    void runAction(
      ready ? t.update : t.install,
      'project',
      [ready ? 'update' : 'install', {}],
      ready ? t.confirmUpdate : t.confirmInstall,
    );
  });
  projectBar.appendChild(checkBtn);
  projectBar.appendChild(projectBtn);

  const msg = ui.msgline();
  actionSheet.body.appendChild(msg);
  const resultBar = ui.actions();
  actionSheet.body.appendChild(resultBar);
  const resultBtn = btn(t.result, () => ui.drawer(t.result, lastResult || oneLine(msg.textContent)));
  resultBtn.title = t.resultTitle;
  resultBar.appendChild(resultBtn);

  /* ── 运行日志：清空动作归在这张卡里，不占操作栏 ── */
  const logSheet = ui.sheet({ title: t.logsTitle, desc: t.logsDesc });
  ctx.root.appendChild(logSheet.el);
  const logBar = ui.actions();
  logSheet.body.appendChild(logBar);
  const clearLogBtn = btn(t.clearLog, () => log.clear());
  clearLogBtn.title = t.clearLogTitle;
  logBar.appendChild(clearLogBtn);
  const log = ui.log({ max: 300, maxHeight: '260px', empty: t.logsEmpty });
  logSheet.body.appendChild(log.el);

  let lastResult = '';
  let projectReady = false;
  let lastState = {};
  let currentVersion = null;
  let latestVersion = null;
  let versionStatus = t.notChecked;
  let versionTone = 'plain';
  let updateAvailable = false;

  function renderVersions() {
    versionBox.replaceChildren(ui.kv([
      { k: t.curVersion, v: currentVersion ?? '—' },
      { k: t.latestVersion, v: latestVersion ?? '—' },
      { k: t.verStatus, v: ui.pill(versionStatus, versionTone) },
    ]));
  }

  /** 只读查版本；查到新版才解锁「更新工程」。失败时保持锁定并给出原因。 */
  async function checkForUpdates() {
    setMsg(msg, `${t.running} ${t.check}…`, false);
    try {
      const info = await ctx.invoke('checkUpdates', [{}]);
      currentVersion = info?.local ?? null;
      latestVersion = info?.latest ?? null;
      updateAvailable = Boolean(info?.hasNewer);
      if (!info?.local) {
        versionStatus = t.notInstalled;
        versionTone = 'off';
      } else if (info.hasNewer) {
        versionStatus = t.newAvailable;
        versionTone = 'on';
      } else {
        versionStatus = t.upToDate;
        versionTone = 'plain';
      }
      renderVersions();
      syncButtons(lastState);
      setMsg(msg, `${t.check} · ${currentVersion ?? '—'} → ${latestVersion ?? '—'} · ${versionStatus}`, false);
      ui.toast(t.check, 'ok');
    } catch (error) {
      versionStatus = t.checkFailed;
      versionTone = 'off';
      updateAvailable = false;
      renderVersions();
      syncButtons(lastState);
      setMsg(msg, `${t.check} ${t.failed}：${message(error)}`, true);
      ui.toast(`${t.check} ${t.failed}`, 'bad');
    }
  }

  /** 按钮该不该亮、装还是更新，都跟着状态刷新；禁用时 title 说明原因。 */
  function syncButtons(s) {
    lastState = s || {};
    const owned = s.mode === 'running';
    startBtn.disabled = Boolean(s.online || s.building);
    startBtn.title = startBtn.disabled ? (s.building ? t.building : t.startWhy) : t.startTitle;
    stopBtn.disabled = !owned;
    stopBtn.title = stopBtn.disabled ? t.stopWhy : t.stopTitle;
    openBtn.disabled = !s.online;
    openBtn.title = openBtn.disabled ? t.openWhy : t.openTitle;
    projectReady = Boolean(s.valid && s.deps);
    projectBtn.textContent = projectReady ? t.update : t.install;
    if (projectReady) {
      projectBtn.disabled = !updateAvailable;
      projectBtn.title = updateAvailable ? t.updateTitle : t.updateWhy;
    } else {
      projectBtn.disabled = false;
      projectBtn.title = t.installTitle;
    }
  }

  async function runAction(label, method, args, confirmBody) {
    if (confirmBody && !(await ui.confirm({ title: label, body: confirmBody, danger: true }))) return;
    setMsg(msg, `${t.running} ${label}…`, false);
    try {
      const out = await ctx.invoke(method, args);
      lastResult = typeof out === 'string' ? out : String(out?.text ?? JSON.stringify(out, null, 2));
      setMsg(msg, `${label} · ${oneLine(lastResult)}`, false);
      ui.toast(`${label} · ${t.done}`, 'ok');
      if (method === 'project' && (args?.[0] === 'update' || args?.[0] === 'install')) {
        // 安装或更新后版本号发生变化，此前的检查结论失效，须重新检查方可再次更新
        updateAvailable = false;
        versionStatus = t.notChecked;
        versionTone = 'plain';
        latestVersion = null;
        renderVersions();
      }
      await refresh();
    } catch (error) {
      const text = `${label} ${t.failed}：${message(error)}`;
      setMsg(msg, text, true);
      // RPC 失败时服务端日志可能尚未轮询到，立即在日志卡补一行，避免界面停留在上一阶段
      log.append(`[失败] ${text}`, 'plain');
      ui.toast(`${label} ${t.failed}`, 'bad');
    }
  }

  async function refresh() {
    try {
      const s = await ctx.invoke('state');
      statusSheet.body.replaceChildren(ui.kv([
        { k: t.service, v: ui.pill(s.building ? t.building : s.online ? t.online : t.offline, s.online ? 'on' : 'off') },
        { k: t.autoBuild, v: s.autoBuild ? t.buildOn : t.buildOff },
        { k: t.source, v: s.ownedSource === 'adopted' ? t.ownedAdopted : s.mode === 'running' ? t.owned : s.mode === 'external' ? t.external : t.none },
        { k: t.port, v: String(s.port) },
        { k: t.address, v: s.endpoint },
        { k: t.project, v: `${s.root}${s.valid ? '' : '（未安装）'}` },
        { k: t.version, v: s.version ?? '—' },
        { k: t.deps, v: s.deps ? t.installed : t.missing },
        { k: t.registry, v: s.registry },
        ...(s.envOverride ? [{ k: t.envOverride, v: 'REMOTION_STUDIO_ROOT' }] : []),
      ]));
      currentVersion = s.version ?? null;
      renderVersions();
      syncButtons(s);
    } catch (error) {
      setMsg(msg, `${t.actionsTitle} ${t.failed}：${message(error)}`, true);
    }
  }

  async function loadConfig() {
    try {
      const cfg = await ctx.invoke('config');
      portInput.value = String(cfg.port ?? 4380);
      registryInput.value = String(cfg.registry ?? '');
      dirInput.value = String(cfg.installDir ?? '');
      autoBuildCb.setChecked(cfg.autoBuild !== false);
      autoStartCb.setChecked(cfg.autoStart === true);
    } catch (error) {
      setMsg(cfgMsg, `${t.failed}：${message(error)}`, true);
    }
  }

  async function saveConfig() {
    const patch = {
      port: Number(portInput.value),
      registry: registryInput.value.trim(),
      installDir: dirInput.value.trim(),
      autoBuild: autoBuildCb.checked,
      autoStart: autoStartCb.checked,
    };
    try {
      const out = await ctx.invoke('saveConfig', [patch]);
      setMsg(cfgMsg, `${t.saved}：${(out?.saved ?? []).join('、')} · ${t.nowPort} ${out?.port}`, false);
      ui.toast(t.saved, 'ok');
      await refresh();
      await loadConfig();
    } catch (error) {
      setMsg(cfgMsg, `${t.failed}：${message(error)}`, true);
    }
  }

  renderVersions();
  void refresh();
  void loadConfig();
  ctx.interval(() => { void refresh(); }, 6000);
  let lastSeq = 0;
  ctx.interval(async () => {
    try {
      const out = await ctx.invoke('logs', [lastSeq, 200]);
      if (typeof out?.lastSeq === 'number') lastSeq = out.lastSeq;
      for (const entry of out?.entries ?? []) {
        log.append(`#${entry.seq} [${entry.stream}] ${entry.text}`, entry.stream === 'sys' ? 'dim' : 'plain');
      }
    } catch {
      // 面板卸载时请求随 ctx.signal 取消，无需提示
    }
  }, 3000);
}

export default {
  panels: { control: { mount } },
};
