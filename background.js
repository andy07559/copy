// 国际化消息获取函数
const i18n = (key) => chrome.i18n.getMessage(key);

// 存储所有活动标签页的连接
let activeConnections = new Map();
let cleanupTimer = null;
let injectionQueue = new Map();  // 存储注入队列
const INJECTION_TIMEOUT = 10000;  // 注入超时时间
const MAX_INJECTION_RETRIES = 3;  // 最大注入重试次数

// 存储自动复制开关状态的键名
const AUTO_COPY_KEY = "auto_clipboard_enabled";

/**
 * 清理无效的标签页连接
 * 通过发送ping消息来检测连接是否有效
 * 如果连接无效则从Map中移除
 */
function cleanupConnections() {
  for (const [tabId, port] of activeConnections) {
    try {
      port.postMessage({ type: 'ping' });
    } catch (error) {
      console.warn(`清理失效连接 (tabId: ${tabId}):`, error);
      activeConnections.delete(tabId);
      
      // 如果页面仍然存在，尝试重新注入
      chrome.tabs.get(tabId).then(() => {
        ensureContentScriptInjected(tabId).catch(console.error);
      }).catch(() => {
        // 标签页不存在，从队列中移除
        injectionQueue.delete(tabId);
      });
    }
  }
}

/**
 * 启动定期清理定时器
 * 每60秒执行一次清理
 */
function startCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  cleanupTimer = setInterval(cleanupConnections, 60000);
}

/**
 * 停止清理定时器
 */
function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// 监听来自content-script的连接请求
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content-script') {
    const tabId = port.sender.tab.id;
    
    // 如果该标签页已有旧连接，先断开并清理
    const oldPort = activeConnections.get(tabId);
    if (oldPort) {
      try {
        oldPort.disconnect();
      } catch (error) {
        console.warn('断开旧连接失败:', error);
      }
      activeConnections.delete(tabId);
    }
    
    // 存储新建立的连接
    activeConnections.set(tabId, port);
    console.log(`建立新连接 (tabId: ${tabId})`);
    
    // 确保清理定时器在运行
    if (!cleanupTimer) {
      startCleanup();
    }
    
    // 处理来自content-script的消息
    const messageHandler = (msg) => {
      if (msg.type === 'ping') {
        try {
          port.postMessage({ type: 'pong' });
        } catch (error) {
          console.warn('发送 pong 失败:', error);
          port.disconnect();
        }
      }
    };
    
    // 处理连接断开事件
    const disconnectHandler = () => {
      console.log(`连接断开 (tabId: ${tabId})`);
      activeConnections.delete(tabId);
      port.onMessage.removeListener(messageHandler);
      port.onDisconnect.removeListener(disconnectHandler);
      
      // 如果没有活动连接了，停止清理定时器
      if (activeConnections.size === 0) {
        stopCleanup();
      }
    };
    
    // 注册消息和断开连接的监听器
    port.onMessage.addListener(messageHandler);
    port.onDisconnect.addListener(disconnectHandler);
  }
});

/**
 * 确保内容脚本已经注入到标签页中
 * @param {number} tabId - 标签页ID
 * @returns {Promise<boolean>} 是否成功注入
 */
async function ensureContentScriptInjected(tabId) {
  // 检查是否正在注入
  if (injectionQueue.has(tabId)) {
    return injectionQueue.get(tabId);
  }

  const injectionPromise = (async () => {
    let retryCount = 0;
    
    while (retryCount < MAX_INJECTION_RETRIES) {
      try {
        // 如果已有活动连接，说明脚本已注入
        if (activeConnections.has(tabId)) {
          return true;
        }

        // 尝试发送测试消息
        await chrome.tabs.sendMessage(tabId, { action: "ping" });
        return true;
      } catch (error) {
        if (error.message.includes('Receiving end does not exist')) {
          try {
            // 获取标签页信息
            const tab = await chrome.tabs.get(tabId);
            
            // 检查标签页是否存在且有URL
            if (!tab || !tab.url) {
              console.warn('标签页不存在或没有URL');
              return false;
            }

            // 检查URL是否可以注入
            if (tab.url.startsWith('chrome://') || 
                tab.url.startsWith('edge://') || 
                tab.url.startsWith('about:') || 
                tab.url.startsWith('chrome-extension://') || 
                tab.url.startsWith('file://')) {
              console.warn('无法注入内容脚本到浏览器页面:', tab.url);
              return false;
            }

            // 注入内容脚本
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['initialization.js', 'content-script.js']
            });

            // 等待连接建立
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error('等待连接超时'));
              }, INJECTION_TIMEOUT);

              const checkConnection = () => {
                if (activeConnections.has(tabId)) {
                  clearTimeout(timeout);
                  resolve();
                } else if (retryCount >= MAX_INJECTION_RETRIES) {
                  clearTimeout(timeout);
                  reject(new Error('达到最大重试次数'));
                } else {
                  setTimeout(checkConnection, 500);
                }
              };
              
              setTimeout(checkConnection, 500);
            });

            return true;
          } catch (injectError) {
            console.warn(`注入失败 (重试 ${retryCount + 1}/${MAX_INJECTION_RETRIES}):`, injectError);
            retryCount++;
            
            if (retryCount < MAX_INJECTION_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
              continue;
            }
            
            throw injectError;
          }
        }
        return false;
      }
    }
    
    throw new Error('达到最大注入重试次数');
  })();

  // 将注入Promise添加到队列
  injectionQueue.set(tabId, injectionPromise);

  try {
    const result = await injectionPromise;
    injectionQueue.delete(tabId);
    return result;
  } catch (error) {
    injectionQueue.delete(tabId);
    throw error;
  }
}

// 插件安装或更新时的处理
chrome.runtime.onInstalled.addListener(async () => {
  try {
    // 检查右键菜单配置
    const results = await chrome.storage.sync.get(["contextMenu"]);

    // 初始化自动复制状态
    const autoCopyEnabled = await getAutoCopyEnabled();
    await chrome.storage.sync.set({ [AUTO_COPY_KEY]: autoCopyEnabled });

    // 如果启用了右键菜单，创建菜单项
    if (results.contextMenu === "on") {
      // 创建"自动复制"菜单项
      chrome.contextMenus.create({
        id: "auto_copy",
        title: i18n("auto_copy"),
        contexts: ["all"],
      });

      // 创建"禁用复制"菜单项
      chrome.contextMenus.create({
        id: "disable_copy",
        title: i18n("disable_copy"),
        contexts: ["all"],
      });
    }
  } catch (error) {
    if (error.message === 'Extension context invalidated.') {
      console.log('扩展已重新加载或更新');
    }
    console.error('安装初始化失败:', error);
  }
});

// 处理右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async ({ menuItemId, pageUrl }) => {
  try {
    // 获取不自动复制文本的站点白名单
    const whitehost = ((await chrome.storage.sync.get(["whitelist"])) ?? {})[
      "whitelist"
    ] ?? {};
    const currenthost = new URL(pageUrl).origin;

    if (menuItemId === "auto_copy") {
      // 从白名单中移除当前域名，启用自动复制
      whitehost[currenthost] = undefined;
      await chrome.storage.sync.set({whitelist: whitehost});
    } else if (menuItemId === "disable_copy") {
      // 将当前域名加入白名单，禁用自动复制
      whitehost[currenthost] = true;
      await chrome.storage.sync.set({whitelist: whitehost});
    }
  } catch (error) {
    if (error.message === 'Extension context invalidated.') {
      console.log('扩展已重新加载或更新');
    }
    console.error('右键菜单操作失败:', error);
  }
});

// 处理快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "copy_full_page") {
    try {
      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        console.error('未找到活动标签页');
        return;
      }

      // 确保内容脚本已注入
      const isInjected = await ensureContentScriptInjected(tab.id);
      if (!isInjected) {
        console.error('无法注入内容脚本');
        return;
      }

      // 发送复制整页内容的命令
      await chrome.tabs.sendMessage(tab.id, { action: "copyFullPage" });
    } catch (error) {
      console.error('快捷键命令执行失败:', error);
    }
  }
});

// 获取自动复制状态
async function getAutoCopyEnabled() {
  try {
    const result = await chrome.storage.sync.get([AUTO_COPY_KEY]);
    return result[AUTO_COPY_KEY] !== false; // 默认为开启状态
  } catch (error) {
    console.error('获取自动复制状态失败:', error);
    return true; // 出错时默认开启
  }
}

// 在注入content-script时传递自动复制状态
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    try {
      // 等待一段时间确保content-script已加载
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 先检查content-script是否已注入
      const isInjected = await ensureContentScriptInjected(tabId);
      if (!isInjected) {
        console.log('content-script未注入，跳过发送消息');
        return;
      }

      // 获取自动复制状态
      const isEnabled = await getAutoCopyEnabled();
      
      // 使用sendMessage的完整形式，包含错误处理
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'updateAutoCopy',
          enabled: isEnabled
        }, (response) => {
          if (chrome.runtime.lastError) {
            // 忽略特定错误
            if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
              console.log('标签页未准备好接收消息，这是正常的');
              resolve();
            } else {
              console.warn('发送消息失败:', chrome.runtime.lastError);
              reject(chrome.runtime.lastError);
            }
          } else {
            resolve(response);
          }
        });
      });
    } catch (error) {
      // 忽略特定错误
      if (error?.message?.includes('Receiving end does not exist')) {
        console.log('标签页未准备好接收消息，这是正常的');
      } else {
        console.error('发送自动复制状态失败:', error);
      }
    }
  }
});

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateAutoCopy') {
    // 更新自动复制状态
    chrome.tabs.query({}, async (tabs) => {
      for (const tab of tabs) {
        try {
          // 检查content-script是否已注入
          const isInjected = await ensureContentScriptInjected(tab.id);
          if (!isInjected) {
            console.log(`标签页 ${tab.id} content-script未注入，跳过发送消息`);
            continue;
          }

          // 使用Promise包装消息发送
          await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'updateAutoCopy',
              enabled: message.enabled
            }, (response) => {
              if (chrome.runtime.lastError) {
                if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
                  console.log(`标签页 ${tab.id} 未准备好接收消息，这是正常的`);
                  resolve();
                } else {
                  console.warn(`发送消息到标签页 ${tab.id} 失败:`, chrome.runtime.lastError);
                  reject(chrome.runtime.lastError);
                }
              } else {
                resolve(response);
              }
            });
          });
        } catch (error) {
          // 忽略特定错误
          if (error?.message?.includes('Receiving end does not exist')) {
            console.log(`标签页 ${tab.id} 未准备好接收消息，这是正常的`);
          } else {
            console.error(`发送消息到标签页 ${tab.id} 失败:`, error);
          }
        }
      }
    });
  }
  return true; // 保持消息通道开启
});
