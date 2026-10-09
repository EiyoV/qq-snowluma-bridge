import puppeteer from 'puppeteer';
import axios from 'axios';

// 配置
const LLM_ROUTER_URL = 'http://localhost:18787/v1/chat/completions';
const QQ_WEB_URL = 'https://w.qq.com/';
const LOGIN_TIMEOUT = 300000; // 5分钟登录超时

// 表情包映射（可根据需要扩展）
const EMOJI_MAP = {
  '哈哈': '😂',
  '笑死': '🤣',
  '开心': '😄',
  '谢谢': '🙏',
  '好的': '✅',
  '收到': '✔️',
  '加油': '💪',
  '厉害': '👍',
  '赞': '👍',
  'ok': '👌',
  '没问题': '👌'
};

async function main() {
  console.log('🚀 启动Web QQ机器人...');
  
  let browser;
  let page;
  
  try {
    // 启动浏览器
    browser = await puppeteer.launch({
      headless: false, // 设置为false以便观察，生产环境可设为true
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1200,800'
      ]
    });
    
    page = await browser.newPage();
    
    // 设置页面配置
    await page.setViewport({ width: 1200, height: 800 });
    
    // 访问QQ网页版
    console.log('🌐 正在访问Web QQ...');
    try {
      await page.goto(QQ_WEB_URL, { waitUntil: 'networkidle2', timeout: 120000 });
      console.log('✅ Web QQ页面加载成功');
    } catch (error) {
      console.log('❌ Web QQ页面加载失败:', error.message);
      console.log('💡 尝试访问备用URL...');
      // 尝试备用URL
      await page.goto('https://q.qq.com/', { waitUntil: 'networkidle2', timeout: 120000 });
      console.log('✅ 备用URL加载成功');
    }
    
    // 等待页面加载完成
    console.log('⏳ 正在等待页面完全加载...');
    await page.waitForTimeout(5000); // 等待5秒确保页面稳定
    
    // 检查当前URL
    const currentUrl = await page.url();
    console.log(`🔍 当前页面URL: ${currentUrl}`);
    
    // 等待登录状态
    console.log('⏳ 正在等待登录...');
    await waitForLogin(page);
    
    // 检查是否已登录
    const isLoggedIn = await checkLogin(page);
    if (!isLoggedIn) {
      console.log('🔑 正在等待登录...');
      await waitForLogin(page);
      console.log('✅ 登录成功！');
    } else {
      console.log('✅ 已检测到登录状态');
    }
    
    // 开始监听消息
    console.log('👂 开始监听QQ消息...');
    await listenForMessages(page);
    
  } catch (error) {
    console.error('❌ 启动失败:', error.message);
    if (page) {
      await page.screenshot({ path: 'web-qq-error.png' });
      console.log('📸 错误截图已保存: web-qq-error.png');
    }
  }
}

async function checkLogin(page) {
  try {
    // 检查QQ网页版的登录状态元素
    await page.waitForSelector('div#mainPanel', { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForLogin(page) {
  // 等待扫码登录完成
  const startTime = Date.now();
  
  while (Date.now() - startTime < LOGIN_TIMEOUT) {
    try {
      // 检查是否出现主面板
      await page.waitForSelector('div#mainPanel', { timeout: 3000 });
      return;
    } catch (error) {
      // 继续等待
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  throw new Error('登录超时，请检查扫码是否完成');
}

async function listenForMessages(page) {
  // 存储最后处理的消息ID，避免重复处理
  let lastMessageId = null;
  
  // 消息监听循环
  setInterval(async () => {
    try {
      // 使用更可靠的QQ网页版消息选择器
      const messages = await page.evaluate(() => {
        const msgElements = document.querySelectorAll('div.message-item, div.msg-content, div.chat-message');
        const messages = [];
        
        msgElements.forEach((el, index) => {
          try {
            // 尝试从不同位置提取消息内容
            const content = el.textContent?.trim() || 
                          el.innerText?.trim() || 
                          el.getAttribute('data-content') || 
                          '';
            
            if (content && content.length > 0 && content.length < 1000) {
              messages.push({
                id: `msg-${Date.now()}-${index}`,
                content: content,
                sender: 'unknown',
                isSelf: el.classList.contains('self') || el.classList.contains('outgoing')
              });
            }
          } catch (e) {
            // 忽略单个元素的错误
          }
        });
        
        return messages;
      });
      
      if (messages.length > 0) {
        for (const message of messages) {
          if (message.id !== lastMessageId && !message.isSelf) {
            lastMessageId = message.id;
            console.log(`📩 收到新消息: ${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''} (来自: ${message.sender})`);
            
            // 调用AI生成回复
            const reply = await generateAIReply(message.content);
            
            // 发送回复
            if (reply) {
              await sendReply(page, reply);
              console.log(`📤 已发送回复: ${reply}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('⚠️ 消息监听错误:', error.message);
    }
  }, 3000); // 每3秒检查一次，更及时
}

async function generateAIReply(messageContent) {
  try {
    // 调用llm-router API
    const response = await axios.post(LLM_ROUTER_URL, {
      model: 'auto',
      messages: [
        {
          role: 'system',
          content: '你是一个友好的QQ聊天助手，用简洁自然的中文回复。不要使用markdown格式，只输出纯文本。'
        },
        {
          role: 'user',
          content: `用户消息: ${messageContent}\n请给出简短、友好、符合QQ聊天风格的回复。`
        }
      ],
      temperature: 0.7,
      max_tokens: 200
    }, {
      timeout: 60000
    });
    
    const reply = response.data.choices[0].message.content.trim();
    
    // 智能表情包匹配
    const emojiKey = Object.keys(EMOJI_MAP).find(key => 
      reply.toLowerCase().includes(key.toLowerCase()) ||
      messageContent.toLowerCase().includes(key.toLowerCase())
    );
    
    if (emojiKey && EMOJI_MAP[emojiKey]) {
      return `${reply} ${EMOJI_MAP[emojiKey]}`;
    }
    
    return reply;
  } catch (error) {
    console.error('❌ AI回复生成失败:', error.message);
    return '抱歉，我现在有点忙，稍后再聊~';
  }
}

async function sendReply(page, reply) {
  try {
    // 这里需要根据实际QQ网页版DOM结构调整
    // 简化版：查找输入框并发送
    await page.evaluate((text) => {
      // 实际实现需要根据QQ网页版的具体DOM结构
      console.log('发送消息:', text);
      // TODO: 实现具体的发送逻辑
    }, reply);
    
    // 模拟发送（实际需要更精确的DOM操作）
    await page.keyboard.type(reply);
    await page.keyboard.press('Enter');
    
  } catch (error) {
    console.error('❌ 发送失败:', error.message);
  }
}

// 启动主函数
main();

// 处理进程退出
process.on('SIGINT', async () => {
  console.log('\n👋 正在关闭Web QQ机器人...');
  process.exit(0);
});