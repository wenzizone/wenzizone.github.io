'use strict';

// 标签/分类聚合页内容单薄且高度重复,禁止收录但允许跟踪链接。
//
// 主题(Butterfly)本身没有"按页面类型"注入 head 内容的配置项——
// _config.butterfly.yml 里的 theme.inject.head 只会无条件注入到
// 每一个页面,没法只在这里生效,所以没法用配置项实现。
//
// 这个脚本放在主仓库自己的 scripts/ 目录下(不是 themes/butterfly 那个
// 子模块),用 Hexo 的 after_render:html filter,在页面渲染成 HTML
// 字符串之后、写盘之前做处理,跟主题解耦——以后主题升级也不会把
// 这个改动冲掉。
hexo.extend.filter.register('after_render:html', function (str, data) {
  if (!data || !data.path) return str;

  const isAggregatePage = /^(tags|categories)\//.test(data.path);
  if (!isAggregatePage) return str;

  // 只替换第一次出现的 </head>——生成的 HTML 里可能还有第二个
  // "</head>" 出现在某段内联 JS 字符串里(跟真正的闭合标签无关),
  // String.prototype.replace 不带 /g 只替换第一处,天然避开这个问题。
  return str.replace('</head>', '<meta name="robots" content="noindex, follow"></head>');
});
