'use strict';

const fs = require('fs');
const path = require('path');
const { BOARD_NAME } = require('../../shared/constants');
const daily = require('../store/daily');
const configStore = require('../store/config');
const secure = require('../store/secure');
const { userRoot } = require('../store/paths');
const SUMMARY_JS = fs.readFileSync(path.join(__dirname, '../../renderer/summaries.js'), 'utf8');

/**
 * 导出「今天这一期」为自包含单文件 HTML。
 *
 * 目的：把它发给别人看（微信传文件、邮件附件都能直接打开），所以要求：
 * - 零外部依赖：CSS/JS 全内联，不引 CDN、不引字体、不引图片（离线可看）。
 * - 数据随文件走：榜单 JSON 内联进 <script>，用 JS 渲染，避免手写几千行 HTML。
 * - **敏感串必须扫干净**：API Key、用户目录、机器名绝不能被带出去。
 *   这是分发给外人的文件，泄漏一次无法收回，所以宁可拒绝导出也不将就。
 * - 视图结构与 APP 保持一致：平台模式（全平台T10 / 单平台）+ 类目模式。
 */

/** 内联 JSON 必须打断 </script> 与 <!--，否则会提前结束脚本块 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function collectSensitiveTokens() {
  const tokens = [];
  try {
    const key = secure.loadKey();
    if (key && key.length >= 8) tokens.push({ label: 'API Key', value: key });
  } catch {
    /* 未配置则无需扫描 */
  }
  try {
    tokens.push({ label: '用户数据目录', value: userRoot() });
  } catch {
    /* ignore */
  }
  if (process.env.USERPROFILE) tokens.push({ label: '用户目录', value: process.env.USERPROFILE });
  if (process.env.USERNAME) tokens.push({ label: '用户名', value: `\\Users\\${process.env.USERNAME}` });
  return tokens.filter((t) => t.value && t.value.length >= 4);
}

/** 返回命中的敏感串标签数组（空数组 = 干净） */
function scanSensitive(text) {
  const hits = [];
  for (const t of collectSensitiveTokens()) {
    if (text.includes(t.value)) hits.push(t.label);
  }
  if (/Bearer\s+[A-Za-z0-9._-]{16,}/.test(text)) hits.push('疑似 Bearer 令牌');
  if (/\bsk-[A-Za-z0-9]{16,}\b/.test(text)) hits.push('疑似 sk- 开头的密钥');
  return hits;
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PAGE_CSS = `
:root{--bg:#f4f5f7;--fg:#1b1f24;--fg2:#454c55;--dim:#78818c;--line:#e3e6ea;--line2:#d3d8de;
--card:#fff;--card2:#fafbfc;--accent:#c8372d;--hot:#c8372d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:26px 20px 60px}
button{font:inherit;cursor:pointer}
a{color:inherit}
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;
padding-bottom:13px;border-bottom:1px solid var(--line)}
h1{font-size:20px;margin:0 0 5px;letter-spacing:.2px}
.meta{color:var(--dim);font-size:12.5px}
.sources{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0 0;font-size:12px;color:var(--dim)}
.src{display:inline-flex;align-items:center;gap:5px}
.src i{width:6px;height:6px;border-radius:50%;background:#1a9c62;display:inline-block}
.src.fail i{background:#cf3b3b}
.src.fail{color:#cf3b3b}

.bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;flex-wrap:wrap;gap:12px;
padding:12px 0;background:rgba(244,245,247,.95);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
.modes{display:inline-flex;gap:2px;padding:3px;background:var(--card2);border:1px solid var(--line);border-radius:10px}
.mode-btn{border:none;background:transparent;color:var(--dim);border-radius:7px;padding:6px 20px;
font-size:13.5px;font-weight:500;line-height:1.2}
.mode-btn:hover{color:var(--fg)}
.mode-btn.on{background:var(--card);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.08)}
input.q{flex:1 1 200px;max-width:300px;margin-left:auto;padding:6px 10px;border:1px solid var(--line2);
border-radius:8px;background:var(--card);font-size:13px;outline:none}
input.q:focus{border-color:var(--accent)}

.subbar{display:flex;flex-direction:column;gap:7px;padding:12px 0 4px}
.subrow{display:flex;align-items:flex-start;gap:9px}
.subbar-label{flex:0 0 34px;padding-top:3px;font-size:12px;color:var(--dim);text-align:right}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);background:var(--card);color:var(--fg2);border-radius:999px;
padding:3px 11px;font-size:12.5px;white-space:nowrap}
.chip:hover{border-color:var(--dim)}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chip .n{opacity:.6;margin-left:4px;font-size:11px}

h2{font-size:14.5px;margin:24px 0 11px;font-weight:650}
h2 .sub{margin-left:6px;font-size:12px;color:var(--dim);font-weight:400}
h2 .cnt{font-size:12px;color:var(--dim);font-weight:400}

.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px;
box-shadow:0 1px 2px rgba(16,24,40,.05)}
.chead{display:flex;gap:12px;align-items:flex-start}
.rank{flex:0 0 26px;height:26px;border-radius:7px;background:var(--card2);border:1px solid var(--line);
color:var(--dim);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
.rank.hot{background:var(--accent);border-color:var(--accent);color:#fff}
.cbody{flex:1 1 auto;min-width:0}
.ttl{font-size:15px;font-weight:600;line-height:1.5;margin:0}
.ttl a{color:inherit;text-decoration:none}
.ttl a:hover{color:var(--accent);text-decoration:underline}
.tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:7px;font-size:11.5px}
.board{border:1px dashed var(--line2);border-radius:5px;padding:0 6px;color:var(--dim)}
.pf{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);background:var(--card2);
border-radius:5px;padding:1px 7px;color:var(--fg2);text-decoration:none}
.pf:hover{border-color:var(--accent);color:var(--accent)}
.pf b{color:var(--dim);font-weight:400}
.badge{background:#fdecea;color:var(--accent);border-radius:5px;padding:1px 6px;font-weight:600}
.deep{margin:10px 0 0;padding:9px 12px;border-left:3px solid #fdecea;background:var(--card2);
border-radius:0 7px 7px 0;font-size:13px;color:var(--fg2);white-space:pre-line}
.deep.none{color:var(--dim)}

.list{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--line)}
.row:first-child{border-top:none}
.row:hover{background:var(--card2)}
.idx{flex:0 0 22px;font-size:12px;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.idx.hot{color:var(--accent);font-weight:700}
.rt{flex:1 1 auto;min-width:0}
.rt a{color:var(--fg);text-decoration:none;font-size:13.5px}
.rt a:hover{color:var(--accent);text-decoration:underline}
.rb{flex:0 0 auto;font-size:11.5px;color:var(--dim);border:1px dashed var(--line2);border-radius:5px;padding:0 6px}
.rb.low{border-style:solid;border-color:transparent;opacity:.55}
.rp{flex:0 0 auto;display:flex;gap:4px}
.rp a{font-size:11.5px;color:var(--fg2);background:var(--card2);border:1px solid var(--line);
border-radius:5px;padding:1px 7px;text-decoration:none}
.rp a:hover{border-color:var(--accent);color:var(--accent)}
.rh{flex:0 0 auto;font-size:11.5px;color:var(--dim);min-width:56px;text-align:right}

.empty{padding:56px 0;text-align:center;color:var(--fg2)}
footer{margin-top:34px;padding-top:13px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
.hide{display:none!important}
.row{flex-wrap:wrap}
.source-summary{margin-top:10px;min-width:0}
.row>.source-summary{flex:0 0 100%;margin-top:0;padding-left:32px}
.summary-control{font-size:12px;color:var(--dim);cursor:pointer;width:fit-content}
.summary-control:hover,.summary-control:focus-visible{color:var(--accent)}
.summary-action{margin-left:9px;font-size:11px}
.summary-content{margin-top:7px;padding:9px 12px;border-left:3px solid #fdecea;background:var(--card2);border-radius:0 7px 7px 0}
.summary-entry+.summary-entry{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.summary-label,.summary-references{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dim);font-size:11.5px}
.summary-text{margin:5px 0 0;font-size:13px;line-height:1.75;white-space:pre-line;overflow-wrap:anywhere;color:var(--fg2)}
.summary-empty{margin:0;font-size:12px;color:var(--dim)}
.summary-references{margin-top:7px}
`;

const PAGE_JS = `
(function(){
  var D = window.__HOTSPOT__;
  var st = { mode:'platform', platform:'all', board:'', q:'' };
  var summaryStates = Object.create(null);
  function summaryPanel(item,scope,open,all){
    return window.hotspotSummaries.createPanel(item,{
      key:D.date+':'+scope+':'+(item.key||item.title),
      open:open,all:all,states:summaryStates,
      link:function(source){ return link('pf',source.name,source.url,'查看来源'); }
    });
  }
  var BOARDS = [
    {id:'society',name:'社会民生'},{id:'ent',name:'娱乐'},
    {id:'tech',name:'科技数码'},{id:'finance',name:'财经商业'},{id:'sports',name:'体育竞技'},
    {id:'world',name:'国际时政'},{id:'life',name:'生活种草'},{id:'health',name:'健康养生'},
    {id:'other',name:'其他'}
  ];
  // 高置信度判定：旧数据没 confidence 字段时回退按来源判断
  function isHigh(item){
    if(!item) return false;
    if(item.confidence) return item.confidence==='high';
    return item.boardSource!=='prior' && item.boardSource!=='fallback';
  }

  function el(tag,cls,text){
    var n=document.createElement(tag);
    if(cls) n.className=cls;
    if(text!=null) n.textContent=text;
    return n;
  }
  function link(cls,text,href,title){
    var a=el('a',cls,text);
    if(href && /^https?:\\/\\//i.test(href)){ a.href=href; a.target='_blank'; a.rel='noopener noreferrer'; if(title) a.title=title; }
    return a;
  }
  function ok(item){
    if(st.board && item.board!==st.board) return false;
    if(st.q && String(item.title||'').toLowerCase().indexOf(st.q)<0) return false;
    return true;
  }
  function pfTags(sources){
    var f=document.createDocumentFragment();
    (sources||[]).forEach(function(s){
      var a=link('pf',s.name,s.url);
      if(s.hotText) a.appendChild(el('b',null,s.hotText));
      f.appendChild(a);
    });
    return f;
  }

  /* ---- 二级筛选 ---- */
  function chips(counts){
    var box=document.getElementById('subbar'); box.innerHTML='';
    function row(label){
      var c=el('div','chips');
      var r=el('div','subrow'); r.appendChild(el('span','subbar-label',label)); r.appendChild(c);
      box.appendChild(r); return c;
    }
    function chip(label,count,on,fn){
      var b=el('button','chip'+(on?' on':''));
      b.appendChild(document.createTextNode(label));
      if(count!=null) b.appendChild(el('span','n',String(count)));
      b.onclick=fn; return b;
    }
    function boardChips(target){
      target.appendChild(chip('全部',null,st.board==='',function(){ st.board=''; render(); }));
      BOARDS.forEach(function(b){
        var n=counts[b.id]; if(!n) return;
        target.appendChild(chip(b.name,n,st.board===b.id,function(){
          st.board = st.board===b.id ? '' : b.id; render();
        }));
      });
    }
    if(st.mode==='platform'){
      var p=row('平台');
      p.appendChild(chip('全平台 Top 10',(D.top10||[]).length,st.platform==='all',function(){
        st.platform='all'; st.board=''; render();
      }));
      (D.platforms||[]).forEach(function(pl){
        p.appendChild(chip(pl.name,pl.count,st.platform===pl.id,function(){
          st.platform=pl.id; st.board=''; render();
        }));
      });
      boardChips(row('类目'));
    } else {
      boardChips(row('类目'));
    }
  }

  /* ---- 内容 ---- */
  function h2(title,sub,count){
    var h=el('h2',null,title);
    if(sub) h.appendChild(el('span','sub',sub));
    if(count!=null) h.appendChild(el('span','cnt','  '+count));
    return h;
  }
  function renderTop(box){
    var list=(D.top10||[]).filter(ok);
    if(!list.length) return 0;
    box.appendChild(h2('全平台 Top 10','跨平台合并 · 按热度加权'));
    list.forEach(function(it){
      var first=(it.sources||[])[0]||{};
      var head=el('div','chead');
      head.appendChild(el('div','rank'+(it.rank<=3?' hot':''),String(it.rank)));
      var body=el('div','cbody');
      var t=el('h3','ttl');
      t.appendChild(link(null,it.title,first.url,'在浏览器中打开来源话题'));
      body.appendChild(t);
      var tags=el('div','tags');
      if(it.badge) tags.appendChild(el('span','badge',
        it.badge==='new'?'新':(it.badge==='surge'?'飙升':'持续')));
      if(it.boardName && isHigh(it))
        tags.appendChild(el('span','board',it.boardName));
      tags.appendChild(pfTags(it.sources));
      body.appendChild(tags);
      head.appendChild(body);
      var card=el('div','card'); card.appendChild(head);
      card.appendChild(summaryPanel(it,'top',true,true));
      box.appendChild(card);
    });
    return list.length;
  }
  function renderPlatform(box){
    var p=null;
    (D.platforms||[]).forEach(function(x){ if(x.id===st.platform) p=x; });
    if(!p) return 0;
    var items=(p.items||[]).filter(ok);
    box.appendChild(h2(p.name,'该平台原始热榜 · 按平台自身排名',items.length+' 条'));
    if(p.status && p.status!=='ok'){
      box.appendChild(el('div','empty',p.name+' 抓取失败'+(p.error?('：'+p.error):'')));
      return 0;
    }
    var list=el('div','list');
    items.forEach(function(it,index){
      var r=el('div','row');
      r.appendChild(el('span','idx'+(it.rank<=3?' hot':''),String(it.rank)));
      var rt=el('div','rt'); rt.appendChild(link(null,it.title,it.url,it.title)); r.appendChild(rt);
      if(it.boardName) r.appendChild(el('span','rb'+(isHigh(it)?'':' low'),it.boardName));
      r.appendChild(el('span','rh',it.hotText||''));
      r.appendChild(summaryPanel(Object.assign({},it,{platform:p.id,platformName:p.name}),'platform-'+p.id,index<3,false));
      list.appendChild(r);
    });
    box.appendChild(list);
    return items.length;
  }
  function renderBoards(box,modeBoard){
    var boards=(D.boards||[]).slice();
    if(modeBoard){
      boards.sort(function(a,b){
        function heat(x){ var m=0; (x.items||[]).forEach(function(i){ if((i.score||0)>m) m=i.score||0; }); return m; }
        return heat(b)-heat(a);
      });
    }
    var n=0;
    boards.forEach(function(b){
      var items=(b.items||[]).filter(ok);
      if(!items.length) return;
      n+=items.length;
      box.appendChild(h2(b.name,null,items.length+' 条'));
      var list=el('div','list');
      items.forEach(function(it,i){
        var first=(it.sources||[])[0]||{};
        var r=el('div','row');
        r.appendChild(el('span','idx',String(i+1)));
        var rt=el('div','rt'); rt.appendChild(link(null,it.title,first.url,it.title)); r.appendChild(rt);
        var rp=el('div','rp');
        (it.sources||[]).forEach(function(s){ rp.appendChild(link(null,s.name,s.url,'打开'+s.name)); });
        r.appendChild(rp);
        r.appendChild(el('span','rh',first.hotText||''));
        r.appendChild(summaryPanel(it,'board-'+b.id,i<3,false));
        list.appendChild(r);
      });
      box.appendChild(list);
    });
    return n;
  }
  function render(){
    // 类目计数口径必须与当前显示内容一致：
    // 选中具体平台时数该平台自己的条目（每条只属一个板块，相加恰好等于该平台条数），
    // 否则会出现「chip 写 社会民生 8、下面正文却是全局 39」这种自相矛盾。
    var scoped=null;
    if(st.mode==='platform' && st.platform!=='all'){
      (D.platforms||[]).forEach(function(pl){ if(pl.id===st.platform) scoped=pl; });
    }
    var counts={};
    if(scoped){
      (scoped.items||[]).forEach(function(it){ counts[it.board]=(counts[it.board]||0)+1; });
    }else{
      (D.boards||[]).forEach(function(b){ counts[b.id]=(b.items||[]).length; });
    }
    chips(counts);
    document.querySelectorAll('.mode-btn').forEach(function(b){
      b.classList.toggle('on', b.dataset.mode===st.mode);
    });

    var box=document.getElementById('content'); box.innerHTML='';
    var showTop = st.mode==='platform';
    var single = st.mode==='platform' && st.platform!=='all';
    var n=0;
    if(single) n+=renderPlatform(box);
    else {
      if(showTop) n+=renderTop(box);
      n+=renderBoards(box, st.mode==='board');
    }
    document.getElementById('empty').classList.toggle('hide', n>0);
  }

  document.getElementById('q').addEventListener('input',function(e){
    st.q=e.target.value.trim().toLowerCase(); render();
  });
  document.querySelectorAll('.mode-btn').forEach(function(b){
    b.addEventListener('click',function(){
      if(st.mode===b.dataset.mode) return;
      st.mode=b.dataset.mode; st.board=''; st.q='';
      document.getElementById('q').value='';
      if(st.mode==='board') st.platform='all';
      render();
    });
  });
  render();
})();
`;

function buildHtml(digest) {
  const title = `热点日报 ${digest.date}`;
  const srcs = (digest.sourceStatus || [])
    .map(
      (s) =>
        `<span class="src${s.status === 'ok' ? '' : ' fail'}"><i></i>${htmlEscape(s.name)}${
          s.status === 'ok' ? ` ${s.count}` : '（失败）'
        }</span>`,
    )
    .join('');

  const generated = digest.generatedAt ? String(digest.generatedAt).slice(0, 16).replace('T', ' ') : '';
  const stats = digest.stats || {};

  const payload = {
    date: digest.date,
    generatedAt: digest.generatedAt || '',
    top10: digest.top10 || [],
    boards: digest.boards || [],
    platforms: digest.platforms || [],
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>热点日报</h1>
      <div class="meta">${htmlEscape(digest.date)}${generated ? ` · 生成于 ${htmlEscape(generated)}` : ''} · 全平台 ${stats.totalItems || 0} 条 / 合并后 ${stats.clusters || 0} 条</div>
    </div>
    <div class="meta">跨平台热点聚合 · 单文件离线版</div>
  </header>
  <div class="sources">${srcs}</div>

  <div class="bar">
    <div class="modes" role="tablist">
      <button type="button" class="mode-btn" data-mode="platform">平台</button>
      <button type="button" class="mode-btn" data-mode="board">类目</button>
    </div>
    <input id="q" class="q" type="search" placeholder="筛选标题…" autocomplete="off">
  </div>

  <div class="subbar" id="subbar"></div>

  <div id="content"></div>
  <div id="empty" class="empty hide">没有匹配的条目</div>

  <footer>本文件为离线快照，所有链接指向原平台页面；数据抓取时间 ${htmlEscape(generated)}。</footer>
</div>
<script>window.__HOTSPOT__ = ${safeJson(payload)};</script>
<script>${SUMMARY_JS}</script>
<script>${PAGE_JS}</script>
</body>
</html>`;
}

/**
 * @returns {Promise<{filePath:string, bytes:number, sensitive:string[]}>}
 */
async function exportToday({ date } = {}) {
  const targetDate = date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const digest = daily.loadDigest(targetDate);
  if (!digest) throw new Error(`${targetDate} 还没有榜单数据，先抓取再导出`);

  const html = buildHtml(digest);

  const hits = scanSensitive(html);
  if (hits.length) {
    const err = new Error(`导出被拦截：内容中检出敏感信息（${hits.join('、')}），为安全起见未生成文件`);
    err.sensitive = hits;
    throw err;
  }

  const cfg = configStore.load();
  const dir = cfg.exportDir || path.join(process.env.USERPROFILE || '.', 'Desktop', '热点日报');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `热点日报-${targetDate}.html`);
  fs.writeFileSync(filePath, html, 'utf8');

  return { filePath, bytes: Buffer.byteLength(html, 'utf8'), sensitive: [] };
}

module.exports = { exportToday, buildHtml, scanSensitive, safeJson, BOARD_NAME };
