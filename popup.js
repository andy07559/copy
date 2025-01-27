// 国际化消息获取函数
const i18n = (key) => chrome.i18n.getMessage(key);

// 背景颜色配置
const bgColors = [
  ['rgba(76, 175, 80, 0.05)', 'rgba(33, 150, 243, 0.05)'],  // 绿蓝
  ['rgba(156, 39, 176, 0.05)', 'rgba(233, 30, 99, 0.05)'],  // 紫粉
  ['rgba(255, 193, 7, 0.05)', 'rgba(255, 87, 34, 0.05)'],   // 黄橙
  ['rgba(0, 150, 136, 0.05)', 'rgba(3, 169, 244, 0.05)'],   // 青蓝
  ['rgba(233, 30, 99, 0.05)', 'rgba(156, 39, 176, 0.05)'],  // 粉紫
  ['rgba(103, 58, 183, 0.05)', 'rgba(33, 150, 243, 0.05)'], // 深紫蓝
];

/**
 * 弹出窗口类
 * 负责管理插件的弹出窗口界面和功能
 */
class Popup {
  constructor() {
    // 存储历史记录的键名
    this._STORAGE_KEY = "auto_clipboard_history";
    // 最大历史记录数量
    this._MAX_HISTORY_COUNT = 500;
    // 单条记录最大长度
    this._MAX_ITEM_LENGTH = 50000;
    // 历史记录数组
    this._history = [];
    // 定时器引用
    this._timer = null;
    // 当前版本号
    this._VERSION = '2.2.0';
    // 初始化页面
    this._initPage().catch(error => {
      if (error.message === 'Extension context invalidated.') {
        console.log('扩展已重新加载或更新，请刷新页面');
        document.body.innerHTML = '<div class="error-message">扩展已更新，请关闭后重新打开</div>';
      }
    });
    // 初始化背景色
    this._initBackground();
  }

  /**
   * 初始化弹出窗口页面
   * 包括加载历史记录、创建界面元素、绑定事件等
   */
  async _initPage() {
    try {
      // 从本地存储加载历史记录
      const storageKey = this._STORAGE_KEY;
      const historyStorage = await chrome.storage.local.get([storageKey]);
      // 转换历史记录格式
      this._history = (historyStorage[storageKey] || []).map((item) =>
        typeof item === "string"
          ? {
              value: item,
              topping: false,
            }
          : item
      );

      // 更新版本号显示
      const versionElem = document.querySelector('.version');
      if (versionElem) {
        versionElem.textContent = `v${this._VERSION}`;
      }

      // 构建历史记录HTML
      const historyHTML = this._buildHistoryHTML();
      // 更新历史记录显示
      const historyContainer = document.querySelector('.copy_history');
      if (historyContainer) {
        historyContainer.innerHTML = historyHTML;
      }

      // 初始化选项页面
      this._initOptionsPage();
      // 绑定事件监听器
      this._addEventListener();

      // 添加云同步按钮事件处理
      document.querySelector('.sync-backup').addEventListener('click', async () => {
        try {
          // 获取当前历史记录
          const historyStorage = await chrome.storage.local.get([this._STORAGE_KEY]);
          // 获取Google认证token
          const token = await this._getAuthToken();
          // 备份到Google Drive
          await this._backupToCloud(token, historyStorage[this._STORAGE_KEY] || []);
          alert('备份成功！');
        } catch (error) {
          console.error('备份失败:', error);
          alert(this._handleError(error));
        }
      });

      // 添加从云端恢复按钮事件处理
      document.querySelector('.sync-restore').addEventListener('click', async () => {
        try {
          // 获取Google认证token
          const token = await this._getAuthToken();
          // 从Google Drive恢复数据
          const cloudData = await this._restoreFromCloud(token);
          if (cloudData && cloudData.history) {
            // 更新本地存储
            await chrome.storage.local.set({
              [this._STORAGE_KEY]: cloudData.history
            });
            this._history = cloudData.history;
            // 重新加载界面
            this._reload();
            alert('恢复成功！');
          }
        } catch (error) {
          console.error('恢复失败:', error);
          alert(this._handleError(error));
        }
      });

    } catch (error) {
      console.error('初始化失败:', error);
      throw error;
    }
  }

  /**
   * 初始化背景色
   */
  _initBackground() {
    let currentIndex = Math.floor(Math.random() * bgColors.length);
    
    // 设置初始背景
    this._setGradient(bgColors[currentIndex]);
    
    // 每30秒切换一次背景色
    setInterval(() => {
      currentIndex = (currentIndex + 1) % bgColors.length;
      this._setGradient(bgColors[currentIndex]);
    }, 30000);
  }

  /**
   * 设置渐变背景
   * @param {Array} colors - 渐变色数组
   */
  _setGradient(colors) {
    const popup = document.querySelector('.popup');
    if (popup) {
      popup.style.background = `linear-gradient(45deg, ${colors[0]}, ${colors[1]})`;
    }
  }

  /**
   * 获取Google认证Token
   * @returns {Promise<string>} 认证token
   */
  async _getAuthToken() {
    return new Promise((resolve, reject) => {
      try {
        // 显示认证进度提示
        const progressElem = document.createElement('div');
        progressElem.className = 'auth-progress';
        progressElem.textContent = '正在进行Google认证...';
        document.body.appendChild(progressElem);

        chrome.identity.getAuthToken({ 
          interactive: true,
          scopes: ['https://www.googleapis.com/auth/drive.file']
        }, function(token) {
          // 移除进度提示
          progressElem.remove();

          if (chrome.runtime.lastError) {
            console.error('获取认证失败:', chrome.runtime.lastError);
            const error = chrome.runtime.lastError;
            let errorMessage = '认证失败: ';

            // 处理常见错误
            if (error.message.includes('OAuth2 not granted or revoked')) {
              errorMessage += '请先授权访问Google Drive';
            } else if (error.message.includes('The user did not approve access')) {
              errorMessage += '用户取消了授权';
            } else if (error.message.includes('network')) {
              errorMessage += '网络连接失败，请检查网络设置';
            } else {
              errorMessage += error.message;
            }

            reject(new Error(errorMessage));
            return;
          }

          if (!token) {
            console.error('未获取到token');
            reject(new Error('认证失败：未获取到访问令牌'));
            return;
          }

          console.log('获取认证成功');
          resolve(token);
        });
      } catch (error) {
        console.error('认证过程出错:', error);
        reject(new Error('认证过程出错: ' + error.message));
      }
    });
  }

  /**
   * 处理备份/恢复过程中的错误
   * @param {Error} error - 错误对象
   * @returns {string} 用户友好的错误消息
   */
  _handleError(error) {
    let message = '';
    
    if (error.message.includes('认证失败')) {
      message = error.message;
    } else if (error.message.includes('network')) {
      message = '网络连接失败，请检查网络设置';
    } else if (error.message.includes('permission')) {
      message = '没有足够的权限访问Google Drive，请重新授权';
    } else if (error.message.includes('quota')) {
      message = 'Google Drive存储空间不足';
    } else {
      message = '操作失败: ' + error.message;
    }

    return message;
  }

  /**
   * 备份数据到Google Drive
   * @param {string} token - Google认证token
   * @param {Array} data - 要备份的数据
   */
  async _backupToCloud(token, data) {
    const BACKUP_FILE_NAME = `xiaolin-clipboard-backup-${new Date().toISOString().slice(0,10)}.json`;
    const FILE_MIME_TYPE = 'application/json';

    try {
        // 显示进度提示
        const progressElem = document.createElement('div');
        progressElem.className = 'backup-progress';
        progressElem.textContent = '准备备份...';
        document.body.appendChild(progressElem);

        // 添加数据校验和版本信息
        const backupData = {
            timestamp: Date.now(),
            version: '2.1',
            checksum: await this._calculateChecksum(data),
            history: data
        };

        progressElem.textContent = '查找备份文件...';
        // 查找已有的备份文件
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name contains 'xiaolin-clipboard-backup'`,
            {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error('查询文件失败: ' + response.statusText);
        }

        const result = await response.json();
        console.log('查询结果:', result);

        // 创建新的备份文件
        progressElem.textContent = '创建备份文件...';
        const metadata = {
            name: BACKUP_FILE_NAME,
            mimeType: FILE_MIME_TYPE
        };
        const createResponse = await fetch(
            'https://www.googleapis.com/drive/v3/files',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            }
        );

        if (!createResponse.ok) {
            throw new Error('创建文件失败: ' + createResponse.statusText);
        }

        const file = await createResponse.json();
        const fileId = file.id;
        console.log('新文件创建成功:', fileId);

        // 更新文件内容
        progressElem.textContent = '上传数据中...';
        const form = new FormData();
        form.append(
            'metadata',
            new Blob([JSON.stringify({ mimeType: FILE_MIME_TYPE })], { type: 'application/json' })
        );
        form.append(
            'file',
            new Blob([JSON.stringify(backupData)], { type: FILE_MIME_TYPE })
        );

        const updateResponse = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
            {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}` },
                body: form
            }
        );

        if (!updateResponse.ok) {
            throw new Error('更新文件失败: ' + updateResponse.statusText);
        }

        progressElem.textContent = '备份完成！';
        setTimeout(() => progressElem.remove(), 1500);
        console.log('备份完成');
        return true;
    } catch (error) {
        console.error('备份过程出错:', error);
        throw error;
    }
  }

  /**
   * 计算数据校验和
   * @param {Array} data - 要计算校验和的数据
   * @returns {string} 校验和
   */
  async _calculateChecksum(data) {
    const text = JSON.stringify(data);
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  }

  /**
   * 从Google Drive恢复数据
   * @param {string} token - Google认证token
   * @returns {Promise<Object>} 恢复的数据
   */
  async _restoreFromCloud(token) {
    try {
        // 显示进度提示
        const progressElem = document.createElement('div');
        progressElem.className = 'restore-progress';
        progressElem.textContent = '正在获取备份列表...';
        document.body.appendChild(progressElem);

        // 查找所有备份文件
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name contains 'xiaolin-clipboard-backup'&orderBy=createdTime desc`,
            {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error('查询文件失败: ' + response.statusText);
        }

        const result = await response.json();
        console.log('查询结果:', result);

        if (!result.files || result.files.length === 0) {
            progressElem.remove();
            throw new Error('未找到备份文件');
        }

        // 显示备份文件选择对话框
        const fileId = await this._showBackupSelector(result.files);
        if (!fileId) {
            progressElem.remove();
            return null;
        }

        progressElem.textContent = '正在下载备份数据...';
        // 获取文件内容
        const contentResponse = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            }
        );

        if (!contentResponse.ok) {
            throw new Error('获取文件内容失败: ' + contentResponse.statusText);
        }

        const backupData = await contentResponse.json();
        
        // 验证数据完整性
        progressElem.textContent = '验证数据完整性...';
        if (backupData.checksum) {
            const calculatedChecksum = await this._calculateChecksum(backupData.history);
            if (calculatedChecksum !== backupData.checksum) {
                throw new Error('数据校验失败，备份文件可能已损坏');
            }
        }

        // 询问用户如何处理现有数据
        const mergeStrategy = await this._showMergeOptions();
        if (!mergeStrategy) {
            progressElem.remove();
            return null;
        }

        progressElem.textContent = '正在合并数据...';
        // 合并数据
        const mergedData = await this._mergeData(backupData.history, mergeStrategy);

        progressElem.textContent = '恢复完成！';
        setTimeout(() => progressElem.remove(), 1500);

        return { history: mergedData };
    } catch (error) {
        console.error('恢复过程出错:', error);
        throw error;
    }
  }

  /**
   * 显示备份文件选择对话框
   * @param {Array} files - 备份文件列表
   * @returns {Promise<string>} 选中的文件ID
   */
  async _showBackupSelector(files) {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'backup-selector';
        dialog.innerHTML = `
            <div class="backup-selector-content">
                <h3>选择要恢复的备份</h3>
                <div class="backup-list">
                    ${files.map(file => `
                        <div class="backup-item" data-id="${file.id}">
                            ${file.name.replace('xiaolin-clipboard-backup-', '备份 ')}
                        </div>
                    `).join('')}
                </div>
                <div class="backup-selector-buttons">
                    <button class="cancel-button">取消</button>
                </div>
            </div>
        `;

        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .backup-selector {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            }
            .backup-selector-content {
                background: white;
                padding: 20px;
                border-radius: 8px;
                max-width: 400px;
                width: 90%;
            }
            .backup-list {
                max-height: 300px;
                overflow-y: auto;
                margin: 10px 0;
            }
            .backup-item {
                padding: 10px;
                border-bottom: 1px solid #eee;
                cursor: pointer;
            }
            .backup-item:hover {
                background: #f5f5f5;
            }
            .backup-selector-buttons {
                text-align: right;
                margin-top: 10px;
            }
            .cancel-button {
                padding: 5px 15px;
                border: none;
                background: #ddd;
                border-radius: 4px;
                cursor: pointer;
            }
            .cancel-button:hover {
                background: #ccc;
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(dialog);

        // 绑定事件
        dialog.addEventListener('click', (e) => {
            if (e.target.classList.contains('backup-item')) {
                dialog.remove();
                resolve(e.target.dataset.id);
            } else if (e.target.classList.contains('cancel-button')) {
                dialog.remove();
                resolve(null);
            }
        });
    });
  }

  /**
   * 显示数据合并选项对话框
   * @returns {Promise<string>} 选择的合并策略
   */
  async _showMergeOptions() {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'merge-options';
        dialog.innerHTML = `
            <div class="merge-options-content">
                <h3>如何处理现有数据？</h3>
                <div class="merge-option" data-strategy="replace">
                    替换现有数据
                </div>
                <div class="merge-option" data-strategy="merge">
                    合并到现有数据
                </div>
                <div class="merge-selector-buttons">
                    <button class="cancel-button">取消</button>
                </div>
            </div>
        `;

        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .merge-options {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            }
            .merge-options-content {
                background: white;
                padding: 20px;
                border-radius: 8px;
                max-width: 300px;
                width: 90%;
            }
            .merge-option {
                padding: 10px;
                border: 1px solid #eee;
                margin: 10px 0;
                cursor: pointer;
                border-radius: 4px;
            }
            .merge-option:hover {
                background: #f5f5f5;
            }
            .merge-selector-buttons {
                text-align: right;
                margin-top: 10px;
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(dialog);

        // 绑定事件
        dialog.addEventListener('click', (e) => {
            if (e.target.classList.contains('merge-option')) {
                dialog.remove();
                resolve(e.target.dataset.strategy);
            } else if (e.target.classList.contains('cancel-button')) {
                dialog.remove();
                resolve(null);
            }
        });
    });
  }

  /**
   * 合并数据
   * @param {Array} cloudData - 云端数据
   * @param {string} strategy - 合并策略
   * @returns {Array} 合并后的数据
   */
  async _mergeData(cloudData, strategy) {
    if (strategy === 'replace') {
        return cloudData;
    } else if (strategy === 'merge') {
        // 合并数据，去重并保持置顶状态
        const existingData = this._history || [];
        const mergedMap = new Map();
        
        // 先处理现有数据
        existingData.forEach(item => {
            mergedMap.set(item.value, item);
        });
        
        // 合并云端数据
        cloudData.forEach(item => {
            if (!mergedMap.has(item.value)) {
                mergedMap.set(item.value, item);
            }
        });
        
        // 转换回数组并限制数量
        return Array.from(mergedMap.values())
            .slice(0, this._MAX_HISTORY_COUNT);
    }
    return cloudData;
  }

  // 初始化打赏二维码
  _initQrcode() {
    const i18n = (key) => chrome.i18n.getMessage(key);
    const html = `
      <div class="qrcode_content">
        <h1 class="popup_title"><span class="qrcode_back"></span>${i18n("thank_you")}</h1>
        <div class="qrcode"></div>
      </div>
    `
    const qrcodeDom = document.createElement("div");
    qrcodeDom.className = "qrcode_wrapper";
    qrcodeDom.setAttribute("tabindex", "-1");
    qrcodeDom.innerHTML = html;
    document.body.appendChild(qrcodeDom);
  }
  // 初始化配置页面
  _initOptionsPage() {
    const i18n = (key) => chrome.i18n.getMessage(key);

    // 默认颜色
    const DEFAULT_VALUE = {
      copy: true,
      tooltip: true,
      background: "#51b362",
      color: "#FFFFFF",
      contextMenu: true,
    };

    const optionsHTML = `
      <div class="auto_clipboard_options">
        <h1 class="popup_title"><span class="back" title="${i18n(
          "back"
        )}"></span>${i18n("setting")}</h1>
        <form id="optionForm" name="optionForm">
          <h3>${i18n("operation")}</h3>
          <div class="form_item"><label class="label"><input type="checkbox" name="copy" checked="${
            DEFAULT_VALUE.copy
          }" />${i18n("copy")}</label>
          </div>
          <div class="form_item"><label class="label"><input type="checkbox" name="tooltip" checked="${
            DEFAULT_VALUE.tooltip
          }" />${i18n("tooltip")}</label>
          <div class="form_item"><label class="label"><input type="checkbox" name="contextMenu" checked="${
            DEFAULT_VALUE.contextMenu
          }" />${i18n("contextMenu")}</label>
          </div>
          <h3>${i18n("color")}</h3>
          <div class="setting-color">
            <div class="setting-item">
              <div class="form_item">${i18n(
                "messageBackground"
              )}<label><input type="color" name="background" value="${
      DEFAULT_VALUE.background
    }" /></label></div>
              <div class="form_item">${i18n(
                "messageColor"
              )}<label><input type="color" name="color" value="${
      DEFAULT_VALUE.color
    }" /></label></div>
            </div>
            <div class="preview_wrap">
              <span class="preview_desc">${i18n("preview")}：</span>
              <span class="preview rightBottom" id="preview">${i18n(
                "copySuccess"
              )}</span>
            </div>
          </div>
          <div class="form_submit">
            <button id="submit" type="button">${i18n("save")}</button>
            <button id="recover" type="reset">${i18n("reset")}</button>
            <span class="option_tips">${i18n("saveSuccess")}</span>
          </div>
        </form>
      </div>
    `;
    const optionsDOM = document.createElement("div");
    optionsDOM.className = "options_wrapper";
    optionsDOM.setAttribute("tabindex", "-1");
    optionsDOM.innerHTML = optionsHTML;
    document.body.appendChild(optionsDOM);

    const dq = (selector) => document.querySelector(selector);
    const optionForm = dq("#optionForm");
    const saveButton = dq("#submit");
    const preview = dq("#preview");
    const tips = dq(".option_tips");

    // 更新预览
    const updatePreviewStyle = (style) => {
      Object.keys(style).forEach((key) => {
        preview.style[key] = style[key];
      });
    };

    // 初始化
    const init = (config = DEFAULT_VALUE) => {
      // 数据回填表单
      document.optionForm.background.value = config.background;
      document.optionForm.color.value = config.color;
      document.optionForm.copy.checked = config.copy;
      document.optionForm.tooltip.checked = config.tooltip;
      document.optionForm.contextMenu.checked = config.contextMenu;
      // 更新预览
      updatePreviewStyle({
        background: config.background,
        color: config.color,
      });
    };

    chrome.storage.sync.get(
      ["background", "color", "copy", "tooltip", "contextMenu"],
      (results) => {
        console.log("popup results", results);
        init({
          ...DEFAULT_VALUE,
          ...(results || {}),
        });
      }
    );

    // 监听事件
    saveButton.addEventListener("click", async () => {
      const data = new FormData(optionForm);

      // 保存设置
      await chrome.storage.sync.set({
        background: data.get("background"),
        color: data.get("color"),
        copy: data.get("copy"),
        tooltip: data.get("tooltip"),
        contextMenu: data.get("contextMenu"),
      });

      // 处理右键菜单
      try {
        // 先移除所有菜单
        await chrome.contextMenus.removeAll();
        
        // 如果启用了右键菜单，则重新创建
        if (data.get("contextMenu")) {
          await chrome.contextMenus.create({
            id: "auto_copy",
            title: i18n("auto_copy"),
            contexts: ["all"]
          });

          await chrome.contextMenus.create({
            id: "disable_copy",
            title: i18n("disable_copy"),
            contexts: ["all"]
          });
        }

        // 显示保存成功提示
        tips.style.display = "inline-block";
        setTimeout(() => {
          tips.style.display = "none";
        }, 1500);
      } catch (error) {
        console.error('更新右键菜单失败:', error);
      }
    });

    optionForm.addEventListener("reset", () => {
      updatePreviewStyle({
        background: DEFAULT_VALUE.background,
        color: DEFAULT_VALUE.color,
      });

      document.optionForm.background.value = DEFAULT_VALUE.background;
      document.optionForm.color.value = DEFAULT_VALUE.color;
      document.optionForm.copy.checked = DEFAULT_VALUE.copy;
      document.optionForm.tooltip.checked = DEFAULT_VALUE.tooltip;
      document.optionForm.contextMenu.checked = DEFAULT_VALUE.contextMenu;
    });

    optionForm.addEventListener("change", (e) => {
      const name = e.target.name;
      if (["background", "color"].includes(name)) {
        updatePreviewStyle({
          [name]: e.target.value,
        });
      }
    });
  }
  /**
   * @desc 生成历史记录
   * @returns HTMLElement
   */
  _buildHistoryHTML(filterString = "") {
    if (this._history.length === 0)
      return `<div class="empty">${i18n("historyEmpty")}</div>`;
    filterString = filterString.trim().toLowerCase();
    const includeCode = /<[^>]+>/;

    return (
      this._history
        .map((item, index) => {
          // 固定index，即使过滤后也不会变
          item.index = index;
          return item;
        })
        .filter((item) => {
          return filterString.length > 0
            ? item.value.toLowerCase().includes(filterString)
            : true;
        })
        .map((item) => {
          const result = includeCode.test(item.value)
            ? this._renderCode(item.value)
            : `<a class="click_target" title="${item.value}" href="#">${item.value}</a>`;

          return `<span class="copy_item stick">
          <span class="action_item stick_item ${
            item.topping ? "topping" : ""
          }" title="${
            item.topping ? i18n("cancelStick") : i18n("stick")
          }" dindex="${item.index}"></span>
          ${result}
          <span class="action_item delete_item" title="${i18n(
            "delete"
          )}" dindex="${item.index}"></span>
        </span>`;
        })
        .join("") + `<div class="privacy">${i18n("privacy")}</div>`
    );
  }

  _renderCode(str = "") {
    let div = document.createElement("div");
    let textNode = document.createTextNode(str);
    div.append(textNode);

    return `
      <pre title=${div.innerHTML.replace(/\s/g, "&nbsp;")}>
        <code><a class="click_target" href="#">${div.innerHTML}</a></code>
      </pre>
    `;
  }
  /**
   * @desc 复制
   */
  _copy() {
    Popup.copySelectedText()
      .then(() => {
        const messageEle = document.querySelector(".copy_success");
        window.getSelection().removeAllRanges();
        messageEle.style.display = "block";
        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
          messageEle.style.display = "none";
        }, 1500);
      })
      .catch(() => {});
  }

  /**
   * @desc 事件绑定
   */
  _addEventListener() {
    const handleError = (error) => {
      if (error.message === 'Extension context invalidated.') {
        console.log('扩展已重新加载或更新，请刷新页面');
        document.body.innerHTML = '<div class="error-message">扩展已更新，请关闭后重新打开</div>';
      }
    };

    // 点击自动复制
    window.addEventListener(
      "click",
      async (e) => {
        try {
          if (e.target.className === "click_target") {
            this._selectText(e.target);
            await this._copy();
          }
        } catch (error) {
          handleError(error);
        }
      },
      false
    );

    window.addEventListener(
      "click",
      (e) => {
        const classList = e.target.className.split(/\s+/);
        const filterString = document.querySelector("#searchHistory").value;

        // 删除记录
        const handleDelete = (e) => {
          const index = e.target.getAttribute("dindex");
          if (typeof index === "undefined") return;
          this._history.splice(index, 1);
          chrome.storage.local.set({
            [this._STORAGE_KEY]: this._history,
          });
          // 刷新页面
          this._reload(filterString);
        };
        // 置顶
        const handleTopping = (e) => {
          const index = e.target.getAttribute("dindex");
          if (typeof index === "undefined") return;

          // 置顶数据数量
          const toppingCount = this._history.filter(
            (item) => item.topping
          ).length;
          const isCurrentTopping = this._history[index].topping;
          const activeItem = this._history.splice(index, 1)[0];
          const insertIndex = isCurrentTopping ? toppingCount - 1 : 0;

          activeItem.topping = !activeItem.topping;
          this._history.splice(insertIndex, 0, activeItem);

          chrome.storage.local.set({
            [this._STORAGE_KEY]: this._history,
          });
          // 刷新页面
          this._reload(filterString);
        };
        // 显示配置项
        const openOptions = (open = true) => {
          const optionsWrap = document.querySelector(".options_wrapper");
          open
            ? (optionsWrap.classList.add("open"), optionsWrap.focus())
            : optionsWrap.classList.remove("open");
        };
        // 显示赞赏码
        const openQrcode = (open = true) => {
          const optionsWrap = document.querySelector(".qrcode_wrapper");
          open
            ? (optionsWrap.classList.add("open"), optionsWrap.focus())
            : optionsWrap.classList.remove("open");
        };

        if (classList.indexOf("delete_item") > -1) {
          handleDelete(e);
        } else if (classList.indexOf("stick_item") > -1) {
          handleTopping(e);
        } else if (classList.indexOf("setting") > -1) {
          openOptions(true);
        } else if (classList.indexOf("back") > -1) {
          openOptions(false);
        } else if (
          classList.indexOf("donate-wrap") > -1 ||
          classList.indexOf("donate") > -1
        ) {
          openQrcode(true);
        } else if (classList.indexOf("qrcode_back") > -1) {
          openQrcode(false);
        }
      },
      false
    );
    // 回车自动复制
    window.addEventListener("keyup", (e) => {
      const code = e.code || e.key;
      if (
        code === "Enter" &&
        e.target.className.split(/\s+/).indexOf("copy_item") > -1
      ) {
        this._selectText(e.target.querySelector(".click_target"));
        this._copy();
      }
    });
    // 过滤
    window.addEventListener("input", async (e) => {
      try {
        if (e.target.className === "search_history") {
          const searchKey = e.target.value.trim();
          await this._reload(searchKey);
        }
      } catch (error) {
        handleError(error);
      }
    });

    // 添加双击导出功能
    window.addEventListener("dblclick", (e) => {
      if (e.target.className === "click_target") {
        const text = e.target.textContent;
        this._exportToTxt(text);
      }
    });
  }
  /**
   * 刷新页面
   */
  async _reload(filterString = "") {
    try {
      const historyHTML = this._buildHistoryHTML(filterString);
      document.querySelector(".copy_history").innerHTML = historyHTML;
    } catch (error) {
      console.error('刷新失败:', error);
      throw error;
    }
  }
  /**
   * @desc 选中要复制的文本
   */
  _selectText(element) {
    if (!element) return;
    const range = document.createRange();
    const selection = window.getSelection();

    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * @desc 复制选中的文本
   * @returns Promise
   */
  static copySelectedText() {
    const selectedText = window
      .getSelection()
      .toString()
      .replaceAll(/\u00a0/g, " ");
    if (!selectedText || selectedText?.length === 0) return Promise.reject();

    // 仅在https下可用
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(selectedText);
    } else {
      return new Promise((resolve, reject) => {
        document.execCommand("copy") ? resolve() : reject();
      });
    }
  }

  // 获取 Notion Token
  async _getNotionToken() {
    const result = await chrome.storage.sync.get(['notionToken']);
    return result.notionToken;
  }

  // 获取 Notion Database ID
  async _getNotionDatabaseId() {
    const result = await chrome.storage.sync.get(['notionDatabaseId']);
    return result.notionDatabaseId;
  }

  // 同步到 Notion
  async _syncToNotion() {
    const token = await this._getNotionToken();
    const databaseId = await this._getNotionDatabaseId();
    
    if (!token || !databaseId) {
      throw new Error('请先设置 Notion Token 和 Database ID');
    }

    const historyStorage = await chrome.storage.local.get([this._STORAGE_KEY]);
    const history = historyStorage[this._STORAGE_KEY] || [];

    // 创建 Notion 页面
    for (const item of history) {
      try {
        await fetch(`https://api.notion.com/v1/pages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: {
              Name: {
                title: [
                  {
                    text: {
                      content: item.value.substring(0, 100) // 标题使用内容前100个字符
                    }
                  }
                ]
              },
              Content: {
                rich_text: [
                  {
                    text: {
                      content: item.value
                    }
                  }
                ]
              },
              CreatedTime: {
                date: {
                  start: new Date().toISOString()
                }
              }
            }
          })
        });
      } catch (error) {
        console.error('同步单条记录失败:', error);
        // 继续同步其他记录
        continue;
      }
    }
  }

  /**
   * @desc 导出为TXT文件
   */
  _exportToTxt(text) {
    // 创建 Blob 对象
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    
    // 创建下载链接
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    
    // 使用内容的前20个字符作为文件名
    const fileName = text.substring(0, 20).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    a.download = `${fileName}.txt`;
    
    // 触发下载
    document.body.appendChild(a);
    a.click();
    
    // 清理
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
}

new Popup();

// 添加样式
const styles = `
.backup-progress, .restore-progress, .auth-progress {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    z-index: 9999;
    font-size: 14px;
}

.auth-progress {
    background: rgba(66, 133, 244, 0.9);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
`;

// 将样式添加到文档中
const styleSheet = document.createElement('style');
styleSheet.textContent = styles;
document.head.appendChild(styleSheet);
