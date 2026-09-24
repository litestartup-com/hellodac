import helmet from '@fastify/helmet'
import type { FastifyInstance } from 'fastify'

/**
 * P1-1：安全响应头。
 *
 * 为什么需要：前端有大量 `innerHTML` 渲染点，喂进去的是模型输出、工作区文件与
 * 节点日志；唯一的防线是手写的 escape-first 渲染器（`public/assets/md.js`），
 * 它的安全性依赖"所有正则都跑在已转义文本上"这一人肉不变量。CSP 是这层之外的
 * 第二道闸：即使某处转义漏了，注入进来的脚本也没有可执行的来源。
 *
 * 两条部署约束（helmet 的默认值会踩，所以这里显式覆盖）：
 *
 * 1. **明文 HTTP 是受支持的形态**（nginx 三模式之一，install.sh 默认 HTTP）。
 *    所以：不发 `upgrade-insecure-requests`（会把可用的 HTTP 页面升级成打不开的
 *    HTTPS），HSTS 只在 TLS 形态下发（`secure` 与会话 cookie 的 secure 同源判断）。
 * 2. **前端在用内联 style 属性**（board/spend 的渲染），所以 `style-src` 放行
 *    `'unsafe-inline'`；`script-src` 绝不放行 —— 登录页的内联脚本已为此外链化。
 */
export const registerSecurityHeaders = async (app: FastifyInstance, secure: boolean): Promise<void> => {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // 只允许同源脚本：内联与 eval 一律不放行
        'script-src': ["'self'"],
        // 内联样式属性仍在用；样式注入的危害远小于脚本，先放行、后收口
        'style-src': ["'self'", "'unsafe-inline'"],
        // data: 供内嵌的小图标/占位图
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        // 同源 fetch 与 SSE（EventSource）
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // HSTS 只对 HTTPS 有意义；在明文 HTTP 部署上发它会把站点钉死成不可访问
    hsts: secure ? { maxAge: 15552000, includeSubDomains: false } : false,
    // 站内没有跨源隔离需求，开了只会挡住正常资源
    crossOriginEmbedderPolicy: false,
  })
}
