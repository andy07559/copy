const i18n = (key) => chrome.i18n.getMessage(key);

class AutoClipboard {
  constructor() {
    // chrome.storage.local 最大容量为5M，即5242880字节
    // 最多存储条数
    this._MAX_HISTORY_LENGTH = 100;
    // 单条数据最大字符数
    this._MAX_ITEM_LENGTH = 10000;
    // message宽高
    this.MESSAGE_WIDTH = 100;
    this.MESSAGE_HEIGHT = 30;
    this.MESSAGE_MARGING = 20;
    this.timer = null;
    this.message = null;
    // 默认值
    this.websiteIndex = 1; // 默认使用通用处理方式
    
    // 添加调试日志
    console.log('AutoClipboard 初始化开始');
    
    // 添加页面状态标志
    this.isPageVisible = !document.hidden;
    this.isPageActive = true;
    this.reconnectOnVisible = false;
    
    // 初始化状态
    this.isInitialized = false;
    this.isExtensionValid = true;
    this.initRetryCount = 0;
    this.MAX_RETRY_COUNT = 5;  // 减少初始化重试次数
    this.MAX_RECONNECT_ATTEMPTS = 15;  // 增加最大重连次数
    this.RECONNECT_INTERVAL = 1000;  // 减少初始重连间隔
    this.MIN_RECONNECT_INTERVAL = 1000;  // 减少最小重连间隔
    this.MAX_RECONNECT_INTERVAL = 5000;  // 添加最大重连间隔
    this.CONNECTION_TIMEOUT = 15000;  // 增加连接超时时间
    this.connectionAttempts = 0;
    this.lastError = null;
    this.isConnecting = false;
    this.port = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.connectionCheckTimer = null;
    this.lastReconnectTime = 0;
    this.isReconnecting = false;
    this.initializationPromise = null;

    // 添加新的状态标志
    this.extensionContextValid = true;
    this.lastContextCheck = Date.now();
    this.contextCheckInterval = 5000; // 每5秒检查一次扩展上下文
    this.contextCheckTimer = null;
    
    // 添加自动复制开关状态
    this.isAutoCopyEnabled = true;
    
    // 添加重试延迟时间
    this.RETRY_DELAY = 2000;   // 增加重试延迟
    this.MAX_BACKOFF_DELAY = 10000; // 最大退避延迟
    
    // 增加连接状态管理
    this.connectionState = {
      isConnecting: false,
      lastAttempt: 0,
      failures: 0,
      backoffDelay: 1000
    };
    
    // 增加错误恢复标志
    this.recoveryMode = false;
    this.lastRecoveryAttempt = 0;
    this.RECOVERY_COOLDOWN = 30000; // 恢复冷却时间
    
    // 添加特殊域名列表
    this.SPECIAL_DOMAINS = [
      'translate.google.com',
      'cloud.google.com'
    ];
    
    // 初始化时启动上下文检查
    this._startContextCheck();

    // 检查扩展是否可用
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) {
      console.warn('扩展环境不可用，跳过初始化');
      return;
    }

    // 添加页面生命周期监听
    this._setupPageLifecycleListeners();

    // 初始化
    this.initializationPromise = this._initialize();
  }

  /**
   * @desc 设置页面生命周期监听器
   */
  _setupPageLifecycleListeners() {
    // 监听页面可见性变化
    document.addEventListener('visibilitychange', () => {
      this.isPageVisible = !document.hidden;
      console.log('页面可见性变化:', this.isPageVisible ? '可见' : '隐藏');
      
      if (this.isPageVisible && this.reconnectOnVisible) {
        this.reconnectOnVisible = false;
        console.log('页面重新可见，尝试重新连接');
        this._initialize();
      }
    });

    // 监听页面激活状态
    window.addEventListener('pageshow', (event) => {
      this.isPageActive = true;
      console.log('页面显示，来自缓存:', event.persisted);
      
      if (event.persisted) {
        console.log('页面从缓存恢复，重新初始化连接');
        this._initialize();
      }
    });

    window.addEventListener('pagehide', () => {
      this.isPageActive = false;
      console.log('页面隐藏');
      this._clearConnection();
    });

    // 监听页面冻结状态
    if ('onfreeze' in window) {
      window.addEventListener('freeze', () => {
        console.log('页面被冻结');
        this._clearConnection();
        this.reconnectOnVisible = true;
      });
    }

    // 监听页面恢复状态
    if ('onresume' in window) {
      window.addEventListener('resume', () => {
        console.log('页面恢复');
        this._initialize();
      });
    }
  }

  /**
   * @desc 初始化
   */
  async _initialize() {
    try {
      // 检查是否处于恢复模式
      if (this.recoveryMode) {
        const now = Date.now();
        if (now - this.lastRecoveryAttempt < this.RECOVERY_COOLDOWN) {
          console.log('正在恢复模式冷却中，跳过初始化');
          return;
        }
        this.recoveryMode = false;
      }

      // 等待 DOM 加载完成
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      }

      // 检查是否为特殊域名
      if (this._isSpecialDomain()) {
        console.log('特殊域名，使用有限功能模式');
        this._detectWebsites();
        this._addActionListener();
        this.isInitialized = true;
        return;
      }

      // 检查扩展上下文
      if (!this._checkExtensionContext()) {
        throw new Error('扩展上下文无效');
      }

      // 检查页面状态
      if (!this.isPageVisible || !this.isPageActive) {
        console.log('页面当前不可见或不活跃，等待页面激活');
        this.reconnectOnVisible = true;
        return;
      }

      await this._startInitialization();
    } catch (error) {
      console.error('初始化失败:', error);
      
      // 错误恢复处理
      if (error.message.includes('Extension context invalidated')) {
        this.recoveryMode = true;
        this.lastRecoveryAttempt = Date.now();
        console.log('进入恢复模式，等待页面刷新');
        return;
      }

      // 重试处理
      if (this.initRetryCount < this.MAX_RETRY_COUNT) {
        this.initRetryCount++;
        const delay = Math.min(
          this.RETRY_DELAY * Math.pow(2, this.initRetryCount - 1),
          this.MAX_BACKOFF_DELAY
        );
        console.log(`将在 ${delay}ms 后重试初始化 (${this.initRetryCount}/${this.MAX_RETRY_COUNT})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._initialize();
      } else {
        console.error('达到最大初始化重试次数，建议刷新页面');
        this._showError(i18n("initializationError"));
      }
    }
  }

  /**
   * @desc 检查是否为特殊域名
   */
  _isSpecialDomain() {
    try {
      const currentHost = window.location.hostname.toLowerCase();
      return this.SPECIAL_DOMAINS.some(domain => 
        currentHost === domain || currentHost.endsWith('.' + domain)
      );
    } catch (error) {
      console.warn('检查域名失败:', error);
      return false;
    }
  }

  /**
   * @desc 开始初始化
   */
  async _startInitialization() {
    try {
      // 建立连接
      const connected = await this._setupExtensionStateListener();
      if (!connected) {
        throw new Error('无法建立连接');
      }

      // 初始化功能
      await this._init();
      
      this.isInitialized = true;
      this.reconnectAttempts = 0;
      console.log('扩展初始化完成');
    } catch (error) {
      console.error('初始化失败:', error);
      this._scheduleReconnect();
    }
  }

  /**
   * @desc 设置扩展状态监听
   */
  async _setupExtensionStateListener() {
    if (this.connectionState.isConnecting) {
      console.log('正在连接中，跳过重复连接');
      return false;
    }

    // 检查连接时间间隔
    const now = Date.now();
    const timeSinceLastAttempt = now - this.connectionState.lastAttempt;
    if (timeSinceLastAttempt < this.connectionState.backoffDelay) {
      console.log(`等待连接冷却时间 ${this.connectionState.backoffDelay - timeSinceLastAttempt}ms`);
      return false;
    }

    this.connectionState.isConnecting = true;
    this.connectionState.lastAttempt = now;

    try {
      // 清理旧连接
      await this._clearConnection();

      // 创建新连接
      this.port = chrome.runtime.connect({ name: 'content-script' });
      
      // 设置连接事件处理
      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        this._handleDisconnect(error);
      });

      // 重置连接状态
      this.connectionState.failures = 0;
      this.connectionState.backoffDelay = 1000;
      
      return true;
    } catch (error) {
      this._handleConnectionError(error);
      return false;
    } finally {
      this.connectionState.isConnecting = false;
    }
  }

  _handleConnectionError(error) {
    console.error('连接错误:', error);
    
    // 增加失败计数和退避延迟
    this.connectionState.failures++;
    this.connectionState.backoffDelay = Math.min(
      this.RETRY_DELAY * Math.pow(2, this.connectionState.failures),
      this.MAX_BACKOFF_DELAY
    );

    if (error.message.includes('Extension context invalidated')) {
      this.recoveryMode = true;
      this.lastRecoveryAttempt = Date.now();
      console.log('检测到扩展上下文失效，进入恢复模式');
    }
  }

  _handleDisconnect(error) {
    if (error) {
      this._handleConnectionError(error);
    }

    // 清理连接
    this._clearConnection();

    // 检查是否需要重连
    if (this.isPageVisible && this.isPageActive && !this.recoveryMode) {
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          this.connectionState.backoffDelay,
          this.MAX_BACKOFF_DELAY
        );
        console.log(`将在 ${delay}ms 后尝试重新连接 (${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})`);
        this._scheduleReconnect(delay);
      } else {
        console.warn('达到最大重连次数，请刷新页面');
        this._showError(i18n("reconnectError"));
      }
    }
  }

  /**
   * @desc 清理连接
   */
  _clearConnection() {
    try {
      // 检查是否为特殊域名
      if (this._isSpecialDomain()) {
        return; // 特殊域名不需要清理连接
      }

      if (this.port) {
        this.port.disconnect();
        this.port = null;
      }
      
      if (this.connectionCheckTimer) {
        clearInterval(this.connectionCheckTimer);
        this.connectionCheckTimer = null;
      }
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    } catch (error) {
      // 忽略特定错误
      if (error.message.includes('Extension context invalidated')) {
        console.log('扩展上下文已失效，忽略清理错误');
      } else {
        console.warn('清理连接失败:', error);
      }
    }
  }

  /**
   * @desc 安排重连
   */
  _scheduleReconnect(delay = this.RECONNECT_INTERVAL) {
    if (this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      this.isReconnecting = false;
      await this._initialize();
    }, delay);
  }

  /**
   * @desc 开始定期检查连接
   */
  _startConnectionCheck() {
    // 清理旧的定时器
    if (this.connectionCheckTimer) {
      clearInterval(this.connectionCheckTimer);
    }

    // 设置新的定时器
    this.connectionCheckTimer = setInterval(() => {
      if (this.port && this.isExtensionValid) {
        try {
          this.port.postMessage({ type: 'ping' });
        } catch (error) {
          this._handleDisconnect();
        }
      }
    }, 30000); // 每30秒检查一次
  }

  /**
   * @desc 检查扩展上下文是否有效
   */
  _checkExtensionContext() {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        this._handleContextInvalidated();
        return false;
      }
      
      // 尝试访问扩展API以验证上下文
      chrome.runtime.getURL('');
      this.extensionContextValid = true;
      return true;
    } catch (error) {
      if (error.message.includes('Extension context invalidated')) {
        this._handleContextInvalidated();
      }
      return false;
    }
  }

  /**
   * @desc 处理扩展上下文失效
   */
  _handleContextInvalidated() {
    this.extensionContextValid = false;
    this.isExtensionValid = false;
    this._clearAllState();
    
    // 显示友好的错误提示
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 20px;
      background: rgba(255, 68, 68, 0.9);
      color: white;
      border-radius: 4px;
      z-index: 999999;
      font-size: 14px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    `;
    errorDiv.textContent = '扩展已更新或失效，请刷新页面';
    document.body.appendChild(errorDiv);
    
    // 3秒后自动移除提示
    setTimeout(() => {
      if (errorDiv && errorDiv.parentNode) {
        errorDiv.parentNode.removeChild(errorDiv);
      }
    }, 3000);
  }

  /**
   * @desc 清理所有状态
   */
  _clearAllState() {
    this._clearConnection();
    
    if (this.contextCheckTimer) {
      clearInterval(this.contextCheckTimer);
      this.contextCheckTimer = null;
    }
    
    this.isInitialized = false;
    this.isConnecting = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.connectionAttempts = 0;
  }

  /**
   * @desc 设置消息监听器
   */
  _setupMessageListener() {
    try {
      // 移除旧的监听器
      if (chrome.runtime.onMessage.hasListeners()) {
        chrome.runtime.onMessage.removeListener(this._messageHandler);
      }

      // 添加新的监听器
      this._messageHandler = (request, sender, sendResponse) => {
        if (request.action === "ping") {
          sendResponse({ success: true });
          return true;
        }
        if (request.action === "copyFullPage") {
          this._copyFullPage();
          sendResponse({ success: true });
          return true;
        }
        if (request.type === 'updateAutoCopy') {
          this.isAutoCopyEnabled = request.enabled;
          console.log('自动复制状态更新为:', this.isAutoCopyEnabled);
          sendResponse({ success: true });
          return true;
        }
      };

      chrome.runtime.onMessage.addListener(this._messageHandler);
    } catch (error) {
      console.warn('设置消息监听器失败:', error);
    }
  }

  websites = [
    {
      regexp: /^https:\/\/wenku\.baidu\.com\/view\//,
      copySelectedText: () => {
        let text = AutoClipboard.defaultCopySelectedText();
        return new Promise((resolve) => {
          if (!text || text.length === 0) {
            var matchText = /查看全部包含"([\w\W]*?)"的文档/.exec(
              document.body.innerHTML
            );
            return matchText ? resolve(matchText[1]) : resolve('');
          }
          return resolve(text);
        });
      },
    },
    {
      regexp: /^.+/,
      copySelectedText: () => {
        return Promise.resolve(AutoClipboard.defaultCopySelectedText());
      },
    },
  ];

  /**
   * @desc 初始化扩展
   */
  async _initializeExtension() {
    try {
      // 设置扩展状态监听
      this._setupExtensionStateListener();
      
      // 设置消息监听器
      this._setupMessageListener();
      
      // 初始化功能
      await this._init();
      
      this.isInitialized = true;
      console.log('扩展初始化完成');
    } catch (error) {
      console.error('扩展初始化失败:', error);
      if (this.initRetryCount < this.MAX_RETRY_COUNT) {
        this.initRetryCount++;
        console.log(`尝试重新初始化 (${this.initRetryCount}/${this.MAX_RETRY_COUNT})`);
        setTimeout(() => this._initializeExtension(), 1000);
      } else {
        console.error('达到最大重试次数，初始化失败');
      }
    }
  }

  /**
   * @desc 初始化
   */
  async _init() {
    try {
      // 检查扩展上下文
      if (!this._checkExtensionContext()) {
        console.warn('扩展上下文无效，跳过初始化');
        return;
      }

      this._detectWebsites();
      
      // 初始化提示语颜色
      try {
        const config = await this._getStorage();
        if (config) {
          this._createMessage(
            config.background,
            config.color,
            config.messagePosition || this._getDefaultMessagePosition()
          );
        }
      } catch (error) {
        console.warn('获取配置失败，使用默认配置:', error);
        this._createMessage();
      }

      this._addActionListener();
    } catch (error) {
      console.error('初始化失败:', error);
      // 不要在这里抛出错误，让扩展继续运行
      console.warn('使用有限功能继续运行');
    }
  }

  /**
   * @desc 获取默认消息位置
   */
  _getDefaultMessagePosition() {
    const boundary = this._getMessageBoundaryPosition();
    return {
      left: (boundary.left || 0) - this.MESSAGE_MARGING,
      top: (boundary.top || 0) - this.MESSAGE_MARGING
    };
  }

  /**
   * @desc 获取消息边界位置
   */
  _getMessageBoundaryPosition() {
    try {
      return {
        left: Math.max(0, (document.documentElement?.clientWidth || window.innerWidth || 0) - this.MESSAGE_WIDTH),
        top: Math.max(0, (document.documentElement?.clientHeight || window.innerHeight || 0) - this.MESSAGE_HEIGHT)
      };
    } catch (error) {
      console.warn('获取边界位置失败，使用默认值:', error);
      return { left: 0, top: 0 };
    }
  }

  /**
   * @desc 获取配置
   * @returns Promise
   */
  async _getStorage() {
    return await this._safeExecute(async () => {
      return new Promise((resolve) => {
        if (!chrome?.storage?.sync) {
          resolve({
            background: "#51b362",
            color: "white",
            messagePosition: null
          });
          return;
        }

        chrome.storage.sync.get(
          ["background", "color", "messagePosition"],
          (config) => {
            if (chrome.runtime.lastError) {
              resolve({
                background: "#51b362",
                color: "white",
                messagePosition: null
              });
            } else {
              resolve(config || {});
            }
          }
        );
      });
    }) || {
      background: "#51b362",
      color: "white",
      messagePosition: null
    };
  }

  /**
   * @desc 默认的复制选中文本的方法
   * @returns string
   */
  static defaultCopySelectedText() {
    const selectedText = window.getSelection().toString();

    if (!selectedText || selectedText?.trim().length === 0) return "";
    return selectedText;
  }
  /**
   * @desc 替换异常空格
   * @returns string
   */
  replaceAbnormalSpace(value) {
    return value.replaceAll(/\u00a0/g, ' ');
  }

  /**
   * @desc 复制选中的文本
   * @returns Promise<string | undefined>
   */
  async getSelectedText() {
    const result = await this.websites[this.websiteIndex].copySelectedText();
    return new Promise((resolve) => {
      return result && result.length ? resolve(this.replaceAbnormalSpace(result)) : resolve("");
    })
  }

  /**
   * @desc 提示框
   */
  _createMessage(
    background = "#51b362",
    fontColor = "white",
    position = null
  ) {
    try {
      // 如果没有提供位置，使用默认位置
      if (!position) {
        position = this._getDefaultMessagePosition();
      }

      // 创建影子DOM
      const newElement = document.createElement("div");
      newElement.id = "acMessage";
      const message = newElement.attachShadow({ mode: "closed" });
      const content = document.createElement("div");
      const contentStyle = document.createElement("style");
      content.id = "autoClipboardMessage";
      content.className = "ac-message";
      content.innerText = i18n("copySuccess");

      contentStyle.innerText = `
        .ac-message{
          width: ${this.MESSAGE_WIDTH}px;
          height: ${this.MESSAGE_HEIGHT}px;
          text-align: center;
          position: fixed;
          left: ${Math.max(0, position.left)}px;
          top: ${Math.max(0, position.top)}px;
          z-index: 9999999;
          border-radius: 4px;
          font-size: 14px;
          line-height: ${this.MESSAGE_HEIGHT}px;
          margin: 0;
          padding: 0;
          cursor: move;
          box-shadow: rgba(0,0,0,0.2) 0 5px 15px;
          background: ${background};
          color: ${fontColor};
          display: none;
        }
        .ac-message:hover{
          box-shadow: rgba(0,0,0,0.4) 0 5px 15px;
        }
      `;

      message.appendChild(content);
      message.appendChild(contentStyle);
      
      // 确保 document.body 存在
      if (document.body) {
        document.body.appendChild(message.host);
        this.message = content;
        this._addDragListener();
      } else {
        console.warn('document.body 不存在，等待 DOM 加载完成');
        // 等待 DOM 加载完成
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(message.host);
          this.message = content;
          this._addDragListener();
        });
      }

      return message;
    } catch (error) {
      console.error('创建消息提示框失败:', error);
      return null;
    }
  }
  /**
   * @desc 更新Message样式
   * @style CSSStyleDeclaration
   */
  async _updateMessageStyle(style) {
    try {
      if (!this.message || !document.querySelector("#acMessage")) {
        const config = await this._getStorage();
        await this._createMessage(
          config.background,
          config.color,
          config.messagePosition
        );
      }

      if (this.message && this.message.style) {
        Object.keys(style).forEach((key) => {
          if (key in this.message.style) {
            this.message.style[key] = style[key];
          }
        });
      }
    } catch (error) {
      console.warn('更新消息样式失败:', error);
    }
  }
  /**
   * @desc 监听事件回调
   */
  async _handleAction(e) {
    if (!this._checkExtensionContext()) {
      return;
    }

    try {
      console.log('触发复制操作');
      
      const selectedText = await this.getSelectedText();
      if (!selectedText || selectedText.length === 0) {
        console.log('没有选中文本，跳过复制');
        return;
      }

      // 复制到剪切板
      let copySuccess = false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(selectedText);
        copySuccess = true;
      } else {
        copySuccess = document.execCommand("copy");
      }

      if (copySuccess) {
        await this._safeExecute(async () => {
          await this._setMessageHistory(selectedText);
          this._showCopySuccess();
        });
      }
    } catch (error) {
      console.error('复制操作失败:', error);
      if (!error.message.includes('Extension context invalidated')) {
        this._showError(i18n("copyError"));
      }
    }
  }

  /**
   * @desc 显示复制成功提示
   */
  async _showCopySuccess() {
    if (!this._checkExtensionContext() || !this.isInitialized) {
      return;
    }

    try {
      const config = await this._getStorage();
      if (config.tooltip === false) {
        return;
      }

      await this._updateMessageStyle({
        display: "block",
        background: config.background || "#51b362",
        color: config.color || "#FFFFFF"
      });

      clearTimeout(this.timer);
      this._hideMessageSync();
    } catch (error) {
      console.warn('显示成功提示失败:', error);
    }
  }

  _hideMessageSync() {
    this.timer = setTimeout(() => {
      this._updateMessageStyle({
        display: "none",
      });
      this.timer = null;
    }, 2000);
  }
  /**
   * @desc 设置历史记录
   */
  async _setMessageHistory(text = "") {
    if (typeof text !== "string" || text.length === 0) return;
    
    try {
      // 限制字符长度
      if (text.length > this._MAX_ITEM_LENGTH) {
        text = text.slice(0, this._MAX_ITEM_LENGTH);
      }
      const STORAGE_KEY = "auto_clipboard_history";
      let historyStorage = ((await chrome.storage.local.get([STORAGE_KEY])) ?? {})[STORAGE_KEY];
      let historysMerge = [];

      // 更新
      const updateMessageHistory = () => {
        // 复制的内容和历史记录中某条重复，将其位置放到第一位
        const repeatIndex = historyStorage.findIndex(
          (item) => item.value === text
        );
        const toppingCount = historyStorage.filter((item) => item.topping).length;

        let isCurrentTopping = false;
        let insertIndex = toppingCount || 0;

        if (repeatIndex > -1) {
          isCurrentTopping = historyStorage[repeatIndex].topping;
          historyStorage.splice(repeatIndex, 1);
          insertIndex = isCurrentTopping ? 0 : toppingCount;
        }
        historyStorage.splice(insertIndex, 0, {
          value: text,
          topping: isCurrentTopping,
        });
        historysMerge = historyStorage;
        // 限制容量为this._MAX_HISTORY_LENGTH
        if (historysMerge.length > this._MAX_HISTORY_LENGTH) {
          historysMerge.length = this._MAX_HISTORY_LENGTH;
        }
      };

      // 已有历史记录 ? 更新历史记录 : 设置历史记录
      historyStorage
        ? updateMessageHistory()
        : (historysMerge = [
            {
              topping: false,
              value: text,
            },
          ]);

      // 保存到本地存储
      await chrome.storage.local.set({
        [STORAGE_KEY]: historysMerge,
      });

      console.log('保存历史记录成功:', text);
    } catch (error) {
      console.error('保存历史记录失败:', error);
    }
  }

  /**
   * @desc 显示错误提示
   */
  async _showError(message) {
    if (!this._checkExtensionContext() || !this.isInitialized) {
      return;
    }

    try {
      await this._updateMessageStyle({
        display: "block",
        background: "#ff4444",
        color: "#FFFFFF"
      });

      if (this.message) {
        this.message.innerText = message;
        this._hideMessageSync();
      }
    } catch (error) {
      console.warn('显示错误提示失败:', error);
    }
  }

  /**
   * @desc 组合键
   * @arg {Event} event 事件对象
   */
  _combinationKey(event) {
    // 检查扩展上下文是否有效
    if (!chrome.runtime) {
      console.warn('扩展上下文已失效，请刷新页面');
      return;
    }

    if (event.key === "Shift") {
      this._handleAction(event);
    }
  }
  /**
   * @desc 事件绑定
   */
  _addActionListener() {
    const handleActionDebounce = this._debounce(this._handleAction);

    document.addEventListener("keyup", this._combinationKey.bind(this));
    document.addEventListener("mouseup", (e) => {
      // 只有在自动复制开启时才执行
      if (this.isAutoCopyEnabled) {
        handleActionDebounce(e);
      }
    });
    document.addEventListener('selectstart', (e) => e.stopPropagation(), true);
    // document.execCommand("copy") 会触发copy事件，某些站点针对oncopy事件return false，因此需手动setData
    document.addEventListener('copy', (e) => {
      const selectedText = this.replaceAbnormalSpace(window.getSelection().toString().trim());
      selectedText.length > 0 && e.clipboardData.setData('text/plain', selectedText);
    }, true);
  }
  /**
   * @desc 防抖
   * @arg func 需要防抖的函数
   * @arg timeout 防抖时长
   */
  _debounce(func, timeout = 250) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        func.apply(this, args);
      }, timeout);
    };
  }

  /**
   * @desc 拖动
   */
  _addDragListener() {
    if (!this.message) return;
    this.message.addEventListener("mousedown", (e) => {
      const startLeft = e.clientX;
      const startTop = e.clientY;
      const position = e.target.getBoundingClientRect();
      let endLeft = position.left;
      let endTop = position.top;

      const handleMouseMove = (e) => {
        endLeft = position.left + e.clientX - startLeft;
        endTop = position.top + e.clientY - startTop;

        // 限制范围
        endLeft = Math.max(endLeft, 0);
        endLeft = Math.min(
          endLeft,
          document.documentElement.clientWidth - this.MESSAGE_WIDTH
        );
        endTop = Math.min(
          endTop,
          document.documentElement.clientHeight - this.MESSAGE_HEIGHT
        );
        endTop = Math.max(endTop, 0);

        this._updateMessageStyle({
          left: `${endLeft}px`,
          top: `${endTop}px`,
          right: "none",
          bottom: "none",
        });
        e.preventDefault();
      };
      const handleMouseUp = () => {
        // 存储当前位置
        chrome.storage.sync.set({
          messagePosition: {
            left: endLeft,
            top: endTop,
          },
        });
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    });

    this.message.addEventListener("mouseover", () => {
      clearTimeout(this.timer);
    });

    this.message.addEventListener("mouseleave", () => {
      this._hideMessageSync();
    });
  }

  /**
   * @desc 复制整个页面内容
   */
  async _copyFullPage() {
    if (!this._checkExtensionContext()) {
      return;
    }

    try {
      const content = document.body.innerText;
      
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      
      textarea.select();
      const copySuccess = document.execCommand('copy');
      
      document.body.removeChild(textarea);
      
      if (copySuccess) {
        await this._safeExecute(async () => {
          await this._setMessageHistory(content);
          this._showCopySuccess();
        });
      }
    } catch (error) {
      console.error('全屏复制失败:', error);
      if (!error.message.includes('Extension context invalidated')) {
        this._showError(i18n("copyError"));
      }
    }
  }

  /**
   * @desc 安全地执行扩展操作
   */
  async _safeExecute(operation) {
    if (!this._checkExtensionContext()) {
      // 如果连接断开，尝试重新连接
      this._setupExtensionStateListener();
      return null;
    }

    try {
      return await operation();
    } catch (error) {
      if (error.message.includes('Extension context invalidated')) {
        this.isExtensionValid = false;
        // 尝试重新连接
        this._setupExtensionStateListener();
        return null;
      }
      throw error;
    }
  }

  /**
   * @desc 识别特定站点
   */
  _detectWebsites() {
    try {
      const self = this;
      this.websites.find((site, index) => {
        if (site.regexp.test(location.href)) {
          self.websiteIndex = index;
          return true;
        }
      });
    } catch (error) {
      console.warn('识别站点失败，使用默认处理方式:', error);
      this.websiteIndex = 1; // 使用通用处理方式
    }
  }

  /**
   * @desc 启动扩展上下文检查
   */
  _startContextCheck() {
    if (this.contextCheckTimer) {
      clearInterval(this.contextCheckTimer);
    }

    this.contextCheckTimer = setInterval(() => {
      this._checkExtensionContext();
    }, this.contextCheckInterval);
  }
}

new AutoClipboard();
