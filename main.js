const childProcess = require("child_process");
const {
  ItemView,
  Notice,
  Plugin,
  TFile,
  normalizePath,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "life-vault-dashboard-view";
const DEFAULT_SETTINGS = {
  repoUrl: "",
  lastCommitMessage: "",
  autoCreatedFrontmatter: true,
};

function trimOutput(value) {
  return String(value || "").trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function defaultCommitMessage() {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
  return `life vault sync: ${stamp}`;
}

function isGithubRepoUrl(value) {
  const url = value.trim();
  return (
    /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url) ||
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url) ||
    /^ssh:\/\/git@github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)
  );
}

function githubWebUrl(value) {
  const url = value.trim();
  let match = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;

  match = url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;

  match = url.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;

  return "";
}

function friendlySummary(info) {
  if (!info.remoteUrl) {
    return {
      tone: "warning",
      title: "还没有连接 GitHub 仓库",
      body: "展开「高级设置」，填入 GitHub 仓库地址并保存。",
    };
  }

  if (info.behind > 0) {
    return {
      tone: "warning",
      title: "GitHub 上有新内容",
      body: `建议先点「从 GitHub 更新」。云端还有 ${info.behind} 个提交本机没有。`,
    };
  }

  if (info.hasChanges) {
    return {
      tone: "dirty",
      title: "本机有还没上传的修改",
      body: `共有 ${info.changedFiles.length} 个文件有变化。确认无误后点「保存并上传」。`,
    };
  }

  if (info.ahead > 0) {
    return {
      tone: "dirty",
      title: "有内容已保存但还没上传",
      body: `本机还有 ${info.ahead} 个提交没有推送到 GitHub。点「上传到 GitHub」。`,
    };
  }

  return {
    tone: "clean",
    title: "已经同步好了",
    body: "本机和 GitHub 目前一致，可以继续写。",
  };
}

function parsePorcelainLine(line) {
  const status = line.slice(0, 2);
  let path = line.slice(3).trim();
  if (path.includes(" -> ")) {
    path = path.split(" -> ").pop().trim();
  }
  return { status, path };
}

function actionLabel(status) {
  if (status.includes("D")) return "删除";
  if (status.includes("?") || status.includes("A")) return "新增";
  if (status.includes("R")) return "改名";
  return "修改";
}

function buildChangePreview(changedFiles) {
  const items = changedFiles.map((line) => {
    const item = parsePorcelainLine(line);
    return {
      ...item,
      label: actionLabel(item.status),
    };
  });

  const configCount = items.filter((item) => item.path.startsWith(".obsidian/")).length;
  const deletedCount = items.filter((item) => item.status.includes("D")).length;

  return {
    items,
    configCount,
    riskyCount: configCount + deletedCount,
  };
}

function formatPreviewForConfirm(preview, limit = 14) {
  const lines = preview.items.slice(0, limit).map((item) => `- ${item.label} ${item.path}`);
  if (preview.items.length > limit) {
    lines.push(`...另外还有 ${preview.items.length - limit} 个文件`);
  }
  return lines.join("\n");
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateKey(msOrDate) {
  const date = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
  ].join("");
}

function formatDateTime(ms) {
  const date = new Date(ms);
  return `${formatDateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function gitExecutables() {
  const platform = typeof process !== "undefined" ? process.platform : "";

  if (platform === "win32") {
    return [
      "git",
      "git.exe",
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    ];
  }

  if (platform === "darwin") {
    return ["/usr/bin/git", "git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  }

  return ["git", "/usr/bin/git", "/usr/local/bin/git"];
}

function friendlyGitError(error) {
  if (error?.code === "ENOENT") {
    if (typeof process !== "undefined" && process.platform === "win32") {
      return "没有找到 Git。请先安装 Git for Windows，并确认 Obsidian 重启后能在系统 PATH 中找到 git。";
    }
    return "没有找到 Git。请先安装 Git，并确认 Obsidian 能在系统 PATH 中找到 git。";
  }
  return "";
}

function dailyDateFromPath(path) {
  const match = path.match(/^日记\/(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : "";
}

function stripFrontmatter(content) {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) return content.slice(end + 4);
  }
  return content;
}

function frontmatterEndIndex(content) {
  if (!content.startsWith("---\n")) return -1;
  const rest = content.slice(4);
  const match = rest.match(/\n---(?:\n|$)/);
  return match ? 4 + match.index : -1;
}

function frontmatterBlock(content) {
  const end = frontmatterEndIndex(content);
  if (end === -1) return "";
  return content.slice(4, end);
}

function timestampFromFrontmatter(content, field) {
  const block = frontmatterBlock(content);
  if (!block) return null;
  const pattern = new RegExp(`^${field}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m");
  const match = block.match(pattern);
  if (!match) return null;
  const raw = match[1].trim();
  const dateMatch = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!dateMatch) return null;
  return {
    dateKey: dateMatch[1],
    displayTime: dateMatch[2] ? `${dateMatch[1]} ${dateMatch[2]}` : dateMatch[1],
    raw,
  };
}

function createdFromFrontmatter(content) {
  return timestampFromFrontmatter(content, "created");
}

function updatedFromFrontmatter(content) {
  return timestampFromFrontmatter(content, "updated");
}

function withCreatedFrontmatter(content, created) {
  const end = frontmatterEndIndex(content);
  if (end !== -1) {
    const block = frontmatterBlock(content);
    if (/^created:\s*/m.test(block)) return content;
    return `---\ncreated: ${created}\n${content.slice(4)}`;
  }
  return `---\ncreated: ${created}\n---\n\n${content}`;
}

function withUpdatedFrontmatter(content, updated) {
  const end = frontmatterEndIndex(content);
  if (end !== -1) {
    const block = frontmatterBlock(content);
    if (/^updated:\s*/m.test(block)) {
      const nextBlock = block.replace(/^updated:\s*.*$/m, `updated: ${updated}`);
      return `---\n${nextBlock}${content.slice(end)}`;
    }
    if (/^created:\s*/m.test(block)) {
      const nextBlock = block.replace(/^(created:\s*.*)$/m, `$1\nupdated: ${updated}`);
      return `---\n${nextBlock}${content.slice(end)}`;
    }
    return `---\nupdated: ${updated}\n${content.slice(4)}`;
  }
  return `---\nupdated: ${updated}\n---\n\n${content}`;
}

function excerptFromMarkdown(content) {
  const body = stripFrontmatter(content);
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#") && !value.startsWith("- [["));

  if (!line) return "没有正文预览";
  return line.length > 110 ? `${line.slice(0, 110)}...` : line;
}

class LifeVaultDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.detailItems = new Map();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Life Vault 同步面板";
  }

  getIcon() {
    return "layout-dashboard";
  }

  async onOpen() {
    this.render();
    await this.refreshStatus();
    await this.runTimeSearch();
  }

  async onClose() {}

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("life-vault-dashboard-view");

    const shell = root.createDiv({ cls: "life-vault-dashboard" });
    const header = shell.createDiv({ cls: "life-vault-dashboard__header" });
    const titleWrap = header.createDiv();
    titleWrap.createEl("h1", {
      cls: "life-vault-dashboard__title",
      text: "Life Vault 同步面板",
    });
    titleWrap.createDiv({
      cls: "life-vault-dashboard__subtitle",
      text: "把共享笔记的 GitHub 同步变成可点击操作。",
    });

    const headerActions = header.createDiv({ cls: "life-vault-actions" });
    this.addActionButton(headerActions, "刷新", "refresh-cw", async () => {
      await this.refreshStatus();
      await this.runTimeSearch();
    });

    const grid = shell.createDiv({ cls: "life-vault-dashboard__grid" });
    this.renderGitCard(grid);
    this.renderTimeSearchCard(grid);
  }

  renderGitCard(parent) {
    const card = parent.createDiv({ cls: "life-vault-card" });
    const cardHeader = card.createDiv({ cls: "life-vault-card__header" });
    cardHeader.createEl("h2", {
      cls: "life-vault-card__title",
      text: "GitHub 同步",
    });
    this.gitCardMeta = cardHeader.createDiv({
      cls: "life-vault-card__meta",
      text: "等待刷新",
    });

    this.summaryEl = card.createDiv({ cls: "life-vault-summary" });
    this.summaryIconEl = this.summaryEl.createDiv({ cls: "life-vault-summary__icon" });
    setIcon(this.summaryIconEl, "circle-help");
    const summaryText = this.summaryEl.createDiv();
    this.summaryTitleEl = summaryText.createDiv({
      cls: "life-vault-summary__title",
      text: "正在检查同步状态",
    });
    this.summaryBodyEl = summaryText.createDiv({
      cls: "life-vault-summary__body",
      text: "请稍等。",
    });

    const steps = card.createDiv({ cls: "life-vault-steps" });
    this.createStep(steps, "1", "先检查", "看看本机和 GitHub 是否一致。");
    this.createStep(steps, "2", "有云端新内容就先更新", "避免覆盖对方刚写的内容。");
    this.createStep(steps, "3", "确认后再上传", "上传前会再次询问。");

    const actions = card.createDiv({ cls: "life-vault-actions life-vault-actions--primary" });
    this.addActionButton(actions, "检查一下", "search-check", () => this.refreshStatus());
    this.addActionButton(actions, "从 GitHub 更新", "download", () => this.pullLatest());
    this.addActionButton(actions, "保存并上传", "cloud-upload", () => this.saveAndUpload());

    const preview = card.createDiv({ cls: "life-vault-preview" });
    const previewHeader = preview.createDiv({ cls: "life-vault-preview__header" });
    previewHeader.createDiv({ cls: "life-vault-preview__title", text: "上传前预览" });
    this.previewMetaEl = previewHeader.createDiv({
      cls: "life-vault-preview__meta",
      text: "等待检查",
    });
    this.previewBodyEl = preview.createDiv({ cls: "life-vault-preview__body" });
    this.previewBodyEl.createDiv({
      cls: "life-vault-empty",
      text: "点击「检查一下」后，会在这里显示准备上传的内容。",
    });

    const advanced = card.createEl("details", { cls: "life-vault-details" });
    advanced.createEl("summary", { text: "高级信息和设置" });

    const settings = advanced.createDiv({ cls: "life-vault-details__section" });
    const repoField = settings.createDiv({ cls: "life-vault-field" });
    repoField.createEl("label", { text: "GitHub 仓库地址" });
    this.repoInput = repoField.createEl("input", {
      attr: {
        type: "text",
        spellcheck: "false",
        placeholder: "git@github.com:owner/repo.git",
      },
      value: this.plugin.settings.repoUrl,
    });

    const commitField = settings.createDiv({ cls: "life-vault-field" });
    commitField.createEl("label", { text: "上传说明" });
    this.commitInput = commitField.createEl("input", {
      attr: {
        type: "text",
        spellcheck: "false",
      },
      value: this.plugin.settings.lastCommitMessage || defaultCommitMessage(),
    });

    const advancedActions = settings.createDiv({ cls: "life-vault-actions" });
    this.addActionButton(advancedActions, "保存仓库地址", "link", () => this.saveOrigin());
    this.addActionButton(advancedActions, "只保存到本机", "git-commit", () => this.commitAll());
    this.addActionButton(advancedActions, "只上传到 GitHub", "upload", () => this.pushCurrentBranch());

    const detailGrid = advanced.createDiv({ cls: "life-vault-status-grid" });
    this.createDetailItem(detailGrid, "repo", "本地文件夹");
    this.createDetailItem(detailGrid, "branch", "当前分支");
    this.createDetailItem(detailGrid, "remote", "GitHub 地址");
    this.createDetailItem(detailGrid, "sync", "真实同步计数");
    this.createDetailItem(detailGrid, "changes", "真实变更数量");
    this.createDetailItem(detailGrid, "web", "网页地址");

    advanced.createDiv({
      cls: "life-vault-details__caption",
      text: "下面是原始 Git 输出，主要用于排查问题。",
    });
    this.outputEl = advanced.createEl("pre", {
      cls: "life-vault-output",
      text: "等待操作。",
    });
  }

  renderTimeSearchCard(parent) {
    const card = parent.createDiv({ cls: "life-vault-card" });
    const cardHeader = card.createDiv({ cls: "life-vault-card__header" });
    cardHeader.createEl("h2", {
      cls: "life-vault-card__title",
      text: "内容查找",
    });
    this.timeSearchMetaEl = cardHeader.createDiv({
      cls: "life-vault-card__meta",
      text: "按时间查",
    });

    card.createDiv({
      cls: "life-vault-card__hint",
      text: "默认查全部笔记，优先使用 created 时间，并显示 updated 最后修改时间。",
    });

    const autoCreated = card.createDiv({ cls: "life-vault-toggle" });
    this.autoCreatedCheckbox = autoCreated.createEl("input", {
      attr: { type: "checkbox" },
    });
    this.autoCreatedCheckbox.checked = this.plugin.settings.autoCreatedFrontmatter !== false;
    autoCreated.createEl("label", {
      text: "自动维护 created / updated 时间",
    });
    this.autoCreatedCheckbox.addEventListener("change", async () => {
      this.plugin.settings.autoCreatedFrontmatter = this.autoCreatedCheckbox.checked;
      await this.plugin.saveSettings();
      new Notice(this.autoCreatedCheckbox.checked ? "已开启时间信息自动维护" : "已关闭时间信息自动维护");
    });

    const controls = card.createDiv({ cls: "life-vault-search-controls" });
    const fromField = controls.createDiv({ cls: "life-vault-field" });
    fromField.createEl("label", { text: "开始日期" });
    this.searchFromInput = fromField.createEl("input", {
      attr: { type: "date" },
    });

    const toField = controls.createDiv({ cls: "life-vault-field" });
    toField.createEl("label", { text: "结束日期" });
    this.searchToInput = toField.createEl("input", {
      attr: { type: "date" },
    });

    const today = new Date();
    this.searchFromInput.value = formatDateKey(addDays(today, -14));
    this.searchToInput.value = formatDateKey(today);

    const actions = card.createDiv({ cls: "life-vault-actions" });
    this.addSearchButton(actions, "最近 7 天", "calendar-days", () => {
      const now = new Date();
      this.searchFromInput.value = formatDateKey(addDays(now, -6));
      this.searchToInput.value = formatDateKey(now);
      this.runTimeSearch();
    });
    this.addSearchButton(actions, "本月", "calendar-range", () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      this.searchFromInput.value = formatDateKey(monthStart);
      this.searchToInput.value = formatDateKey(now);
      this.runTimeSearch();
    });
    this.addSearchButton(actions, "查找", "search", () => this.runTimeSearch());

    this.timeSearchBodyEl = card.createDiv({ cls: "life-vault-search-results" });
    this.timeSearchBodyEl.createDiv({
      cls: "life-vault-empty",
      text: "选择日期后点击「查找」。",
    });
  }

  createStep(parent, number, title, body) {
    const item = parent.createDiv({ cls: "life-vault-step" });
    item.createDiv({ cls: "life-vault-step__number", text: number });
    const content = item.createDiv();
    content.createDiv({ cls: "life-vault-step__title", text: title });
    content.createDiv({ cls: "life-vault-step__body", text: body });
  }

  createDetailItem(parent, key, label) {
    const item = parent.createDiv({ cls: "life-vault-status-item" });
    item.createDiv({ cls: "life-vault-status-item__label", text: label });
    const value = item.createDiv({
      cls: "life-vault-status-item__value",
      text: "—",
    });
    this.detailItems.set(key, value);
  }

  addActionButton(parent, label, icon, handler) {
    const button = parent.createEl("button");
    const iconEl = button.createSpan();
    setIcon(iconEl, icon);
    button.createSpan({ text: ` ${label}` });
    button.addEventListener("click", async () => {
      await this.runAction(label, handler);
    });
  }

  addSearchButton(parent, label, icon, handler) {
    const button = parent.createEl("button");
    const iconEl = button.createSpan();
    setIcon(iconEl, icon);
    button.createSpan({ text: ` ${label}` });
    button.addEventListener("click", async () => {
      try {
        await handler();
      } catch (error) {
        console.error(error);
        new Notice("查找失败");
      }
    });
  }

  setDetail(key, value, cls) {
    const el = this.detailItems.get(key);
    if (!el) return;
    el.setText(value || "—");
    el.removeClass("life-vault-clean");
    el.removeClass("life-vault-dirty");
    el.removeClass("life-vault-warning");
    if (cls) el.addClass(cls);
  }

  setOutput(text) {
    if (this.outputEl) this.outputEl.setText(text || "");
  }

  setSummary(summary) {
    this.summaryEl.removeClass("life-vault-summary--clean");
    this.summaryEl.removeClass("life-vault-summary--dirty");
    this.summaryEl.removeClass("life-vault-summary--warning");
    this.summaryEl.addClass(`life-vault-summary--${summary.tone}`);
    this.summaryTitleEl.setText(summary.title);
    this.summaryBodyEl.setText(summary.body);
    this.summaryIconEl.empty();
    const icon = summary.tone === "clean" ? "circle-check" : summary.tone === "warning" ? "triangle-alert" : "circle-dot";
    setIcon(this.summaryIconEl, icon);
  }

  renderChangePreview(info) {
    if (!this.previewBodyEl) return;

    this.previewBodyEl.empty();
    if (!info.hasChanges) {
      this.previewMetaEl?.setText("没有待上传文件");
      this.previewBodyEl.createDiv({
        cls: "life-vault-empty",
        text: info.ahead > 0
          ? "本机有已保存但未上传的内容；当前没有新的文件修改。"
          : "当前没有准备上传的文件。",
      });
      return;
    }

    this.previewMetaEl?.setText(`${info.changedFiles.length} 个文件`);

    if (info.preview.configCount > 0) {
      this.previewBodyEl.createDiv({
        cls: "life-vault-preview__warning",
        text: `包含 ${info.preview.configCount} 个本机配置文件。共享前建议确认这些配置确实需要同步。`,
      });
    }

    const list = this.previewBodyEl.createEl("ul", { cls: "life-vault-preview-list" });
    for (const item of info.preview.items) {
      const row = list.createEl("li");
      row.createSpan({ cls: "life-vault-preview-list__tag", text: item.label });
      row.createSpan({ cls: "life-vault-preview-list__path", text: item.path });
    }
  }

  async runAction(label, handler) {
    this.setOutput(`${label}...`);
    try {
      await handler();
    } catch (error) {
      const message = this.plugin.formatGitError(error);
      this.setOutput(`${label}失败：\n${message}`);
      new Notice(`${label}失败`);
    }
  }

  async runTimeSearch() {
    const from = this.searchFromInput.value;
    const to = this.searchToInput.value;
    const results = await this.plugin.searchFilesByDate({ from, to });
    this.renderTimeSearchResults(results, { from, to });
  }

  renderTimeSearchResults(results, query) {
    if (!this.timeSearchBodyEl) return;

    this.timeSearchBodyEl.empty();
    this.timeSearchMetaEl?.setText(`全部笔记，${results.length} 条`);

    if (!results.length) {
      this.timeSearchBodyEl.createDiv({
        cls: "life-vault-empty",
        text: "这个时间范围里没有找到内容。",
      });
      return;
    }

    for (const result of results) {
      const item = this.timeSearchBodyEl.createDiv({ cls: "life-vault-search-result" });
      item.setAttr("tabindex", "0");
      item.createDiv({
        cls: "life-vault-search-result__title",
        text: result.title,
      });
      item.createDiv({
        cls: "life-vault-search-result__meta",
        text: `创建 ${result.displayTime} · 修改 ${result.updatedDisplayTime} · ${result.path}`,
      });
      item.createDiv({
        cls: "life-vault-search-result__excerpt",
        text: result.excerpt,
      });
      item.addEventListener("click", () => {
        this.app.workspace.getLeaf(false).openFile(result.file);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.app.workspace.getLeaf(false).openFile(result.file);
        }
      });
    }
  }

  async refreshStatus(options = {}) {
    const info = await this.plugin.getGitInfo();
    this.setSummary(friendlySummary(info));
    this.renderChangePreview(info);
    this.setDetail("repo", info.repoPath);
    this.setDetail("branch", info.branchText);
    this.setDetail("remote", info.remoteUrl);
    this.setDetail("sync", `本机未上传 ${info.ahead}，GitHub 未下载 ${info.behind}`);
    this.setDetail("changes", info.changeText, info.isClean ? "life-vault-clean" : "life-vault-dirty");
    this.setDetail("web", githubWebUrl(info.remoteUrl));
    this.gitCardMeta?.setText(`最后检查 ${new Date().toLocaleTimeString()}`);
    if (this.repoInput && !this.repoInput.value && info.remoteUrl) {
      this.repoInput.value = info.remoteUrl;
    }
    if (!options.preserveOutput) {
      this.setOutput(info.output);
    }
  }

  async saveOrigin() {
    const repoUrl = this.repoInput.value.trim();
    if (!repoUrl) throw new Error("仓库地址不能为空。");
    if (!isGithubRepoUrl(repoUrl)) {
      throw new Error("当前只接受 github.com 的 SSH 或 HTTPS 仓库地址。");
    }

    await this.plugin.setOrigin(repoUrl);
    this.plugin.settings.repoUrl = repoUrl;
    await this.plugin.saveSettings();
    const webUrl = githubWebUrl(repoUrl);
    this.setOutput(`GitHub 仓库地址已保存：\n${repoUrl}${webUrl ? `\n\n网页地址：${webUrl}` : ""}`);
    new Notice("GitHub 仓库地址已保存");
    await this.refreshStatus({ preserveOutput: true });
  }

  async pullLatest() {
    const result = await this.plugin.runGit(["pull", "--ff-only"], { timeout: 120000 });
    this.setOutput(this.plugin.formatResult("从 GitHub 更新", result));
    new Notice("更新完成");
    await this.refreshStatus({ preserveOutput: true });
  }

  async saveAndUpload() {
    const info = await this.plugin.getGitInfo();
    if (info.behind > 0) {
      this.setOutput("GitHub 上有新内容，请先点「从 GitHub 更新」。");
      new Notice("请先从 GitHub 更新");
      await this.refreshStatus({ preserveOutput: true });
      return;
    }

    if (info.hasChanges) {
      await this.commitAll();
    }

    const refreshed = await this.plugin.getGitInfo();
    if (refreshed.ahead === 0) {
      this.setOutput(refreshed.hasChanges ? "还有未保存的修改，请先处理。" : "没有需要上传的内容。");
      new Notice("没有需要上传的内容");
      await this.refreshStatus({ preserveOutput: true });
      return;
    }

    await this.pushCurrentBranch();
  }

  async commitAll() {
    const message = this.commitInput.value.trim() || defaultCommitMessage();
    const info = await this.plugin.getGitInfo();

    if (!info.hasChanges) {
      this.setOutput("没有需要保存的修改。");
      new Notice("没有需要保存的修改");
      return;
    }

    const previewText = formatPreviewForConfirm(info.preview);
    const warning = info.preview.riskyCount > 0
      ? `\n\n注意：这里包含 ${info.preview.riskyCount} 个删除项或本机配置文件，请确认后再继续。`
      : "";
    const confirmed = window.confirm(
      `将保存当前全部 ${info.changedFiles.length} 个变更。\n\n上传说明：${message}${warning}\n\n上传前预览：\n${previewText}\n\n继续吗？`
    );
    if (!confirmed) {
      this.setOutput("已取消保存。");
      return;
    }

    await this.plugin.runGit(["add", "-A"]);
    const result = await this.plugin.runGit(["commit", "-m", message], { timeout: 120000 });
    this.plugin.settings.lastCommitMessage = message;
    await this.plugin.saveSettings();
    this.setOutput(this.plugin.formatResult("保存到本机", result));
    new Notice("已保存到本机");
    await this.refreshStatus({ preserveOutput: true });
  }

  async pushCurrentBranch() {
    const info = await this.plugin.getGitInfo();
    if (info.behind > 0) {
      this.setOutput("GitHub 上有新内容，请先点「从 GitHub 更新」。");
      new Notice("请先从 GitHub 更新");
      await this.refreshStatus({ preserveOutput: true });
      return;
    }

    const result = await this.plugin.runGit(["push"], { timeout: 120000 });
    this.setOutput(this.plugin.formatResult("上传到 GitHub", result));
    new Notice("上传完成");
    await this.refreshStatus({ preserveOutput: true });
  }
}

module.exports = class LifeVaultDashboardPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.timestampTimers = new Map();

    this.registerView(VIEW_TYPE, (leaf) => new LifeVaultDashboardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", "打开 Life Vault 同步面板", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开同步面板",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "refresh-git-status",
      name: "检查 GitHub 同步状态",
      callback: async () => {
        const info = await this.getGitInfo();
        new Notice(friendlySummary(info).title);
      },
    });

    this.addCommand({
      id: "add-created-to-current-file",
      name: "给当前笔记补时间信息",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
          new Notice("当前没有打开 Markdown 笔记");
          return;
        }
        const changed = await this.ensureTimestampFrontmatter(file, { updateUpdated: true });
        new Notice(changed ? "已补时间信息" : "当前笔记时间信息已是最新");
      },
    });

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.scheduleTimestampUpdate(file, 800);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.scheduleTimestampUpdate(file, 1200);
      })
    );
  }

  async onunload() {
    for (const timer of this.timestampTimers.values()) {
      window.clearTimeout(timer);
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getRepoPath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return "/Users/peterlee/Documents/life vault";
  }

  scheduleTimestampUpdate(file, delay) {
    if (this.settings.autoCreatedFrontmatter === false) return;
    const previous = this.timestampTimers.get(file.path);
    if (previous) window.clearTimeout(previous);

    const timer = window.setTimeout(() => {
      this.timestampTimers.delete(file.path);
      const freshFile = this.app.vault.getAbstractFileByPath(file.path);
      if (freshFile instanceof TFile && freshFile.extension === "md") {
        this.ensureTimestampFrontmatter(freshFile, { updateUpdated: true }).catch((error) => console.error(error));
      }
    }, delay);

    this.timestampTimers.set(file.path, timer);
  }

  async activateView() {
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length === 0) {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      leaves = [leaf];
    }
    this.app.workspace.revealLeaf(leaves[0]);
  }

  runGit(args, options = {}) {
    const cwd = normalizePath(this.getRepoPath());
    const candidates = gitExecutables();

    const tryGit = (index, lastError) => new Promise((resolve, reject) => {
      const executable = candidates[index];
      if (!executable) {
        reject(lastError || new Error("Git executable not found"));
        return;
      }

      childProcess.execFile(
        executable,
        args,
        {
          cwd,
          timeout: options.timeout || 60000,
          maxBuffer: 1024 * 1024 * 5,
        },
        (error, stdout, stderr) => {
          const result = {
            stdout: stdout || "",
            stderr: stderr || "",
          };
          if (error && error.code === "ENOENT" && index < candidates.length - 1) {
            tryGit(index + 1, error).then(resolve, reject);
            return;
          }

          if (error) {
            error.gitResult = result;
            error.gitExecutable = executable;
            reject(error);
            return;
          }
          resolve(result);
        }
      );
    });

    return tryGit(0);
  }

  async searchFilesByDate(query) {
    const from = query.from || "0000-01-01";
    const to = query.to || "9999-12-31";
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const candidates = [];

    for (const file of markdownFiles) {
      const diaryDate = dailyDateFromPath(file.path);
      const content = await this.app.vault.cachedRead(file);
      const created = createdFromFrontmatter(content);
      const updated = updatedFromFrontmatter(content);
      const dateKey = diaryDate || created?.dateKey || formatDateKey(file.stat.ctime);
      if (dateKey < from || dateKey > to) continue;

      candidates.push({
        file,
        path: file.path,
        title: file.basename,
        dateKey,
        displayTime: diaryDate || created?.displayTime || formatDateTime(file.stat.ctime),
        updatedDisplayTime: updated?.displayTime || formatDateTime(file.stat.mtime),
        excerpt: excerptFromMarkdown(content),
      });
    }

    return candidates.sort((a, b) => {
      if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey);
      return b.file.stat.mtime - a.file.stat.mtime;
    });
  }

  async ensureTimestampFrontmatter(file, options = {}) {
    const content = await this.app.vault.read(file);
    const created = formatDateTime(file.stat.ctime || Date.now());
    const updated = formatDateTime(Date.now());
    let nextContent = withCreatedFrontmatter(content, created);
    if (options.updateUpdated !== false) {
      nextContent = withUpdatedFrontmatter(nextContent, updated);
    }
    if (nextContent === content) return false;
    await this.app.vault.modify(file, nextContent);
    return true;
  }

  async getGitInfo() {
    const repoPath = this.getRepoPath();
    const statusResult = await this.runGit(["-c", "core.quotepath=false", "status", "--short", "--branch"]);
    const porcelainResult = await this.runGit(["-c", "core.quotepath=false", "status", "--porcelain=v1"]);

    let remoteUrl = "";
    try {
      remoteUrl = trimOutput((await this.runGit(["remote", "get-url", "origin"])).stdout);
    } catch {
      remoteUrl = "";
    }

    let ahead = 0;
    let behind = 0;
    let upstreamText = "没有上游分支";
    try {
      const counts = trimOutput(
        (await this.runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).stdout
      );
      const [left, right] = counts.split(/\s+/).map((value) => Number(value || 0));
      ahead = left || 0;
      behind = right || 0;
      upstreamText = `本机未上传 ${ahead}，GitHub 未下载 ${behind}`;
    } catch {
      ahead = 0;
      behind = 0;
    }

    const statusText = trimOutput(statusResult.stdout);
    const branchLine = statusText.split("\n")[0] || "未知";
    const changedFiles = trimOutput(porcelainResult.stdout)
      .split("\n")
      .filter(Boolean);
    const preview = buildChangePreview(changedFiles);
    const isClean = changedFiles.length === 0;
    const changeText = isClean ? "没有未保存修改" : `${changedFiles.length} 个文件有变化`;

    if (!this.settings.repoUrl && remoteUrl) {
      this.settings.repoUrl = remoteUrl;
      await this.saveSettings();
    }

    return {
      repoPath,
      remoteUrl,
      ahead,
      behind,
      changedFiles,
      preview,
      hasChanges: changedFiles.length > 0,
      branchText: `${branchLine.replace(/^##\s*/, "")}（${upstreamText}）`,
      isClean,
      changeText,
      output: [
        "git status --short --branch",
        "",
        statusText || "当前没有未保存修改",
        "",
        changedFiles.length ? "有变化的文件：" : "",
        ...changedFiles.slice(0, 40),
        changedFiles.length > 40 ? `...and ${changedFiles.length - 40} more` : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    };
  }

  async setOrigin(repoUrl) {
    let hasOrigin = true;
    try {
      await this.runGit(["remote", "get-url", "origin"]);
    } catch {
      hasOrigin = false;
    }

    if (hasOrigin) {
      await this.runGit(["remote", "set-url", "origin", repoUrl]);
    } else {
      await this.runGit(["remote", "add", "origin", repoUrl]);
    }
  }

  formatResult(label, result) {
    const stdout = trimOutput(result.stdout);
    const stderr = trimOutput(result.stderr);
    return [label, "", stdout, stderr].filter(Boolean).join("\n");
  }

  formatGitError(error) {
    const friendly = friendlyGitError(error);
    if (friendly) return friendly;

    const result = error.gitResult || {};
    return (
      trimOutput(result.stderr) ||
      trimOutput(result.stdout) ||
      error.message ||
      String(error)
    );
  }
};
