/* 自测脚本（仅 ?mock=1&selftest=1 时加载）：脚本化断言厨房切换系统的核心行为，
   结果写入 #selftest-result（PASS/FAIL 行），供无头 Chrome dump-dom 校验。 */

export async function run(ctx) {
  const { ui, usingStub, errors } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, extra) => {
    out.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };
  const flush = () => {
    let pre = document.getElementById('selftest-result');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'selftest-result';
      document.body.appendChild(pre);
    }
    pre.textContent = out.join('\n');
  };

  const cardNames = () =>
    [...document.querySelectorAll('#sw-cards .sw-card .kname')].map((e) => e.textContent);
  const currentName = () => {
    const k = ui.currentKitchen();
    return k ? k.name : null;
  };
  const key = (k) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  try {
    /* 1. 切换条按 lastTs 倒序（快照初始：codex-overcooked > api-server > hugo-blog） */
    await sleep(300);
    const names0 = cardNames();
    check(
      '切换条按 lastTs 倒序',
      JSON.stringify(names0) === JSON.stringify(['codex-overcooked', 'api-server', 'hugo-blog']),
      names0.join(' > ')
    );
    check('初始展示第一间（最近活跃）', currentName() === 'codex-overcooked', currentName());

    /* 2. 跟随最新（默认开）：别家厨房来新事件时自动跳过去 */
    let jumped = false;
    for (let i = 0; i < 40 && !jumped; i++) {
      await sleep(200);
      jumped = currentName() !== 'codex-overcooked';
    }
    check('跟随最新自动跳转', jumped, '跳到 ' + currentName());

    /* 3. 点击卡片切换（手动） */
    const cards = () => [...document.querySelectorAll('#sw-cards .sw-card')];
    let target = null;
    cards().forEach((c) => {
      if (c.querySelector('.kname').textContent === 'api-server') target = c;
    });
    check('找到 api-server 卡片', !!target);
    if (target) {
      target.click();
      await sleep(50);
      check('点击切换到 api-server', currentName() === 'api-server', currentName());
      check('当前卡片高亮 .on', target.classList.contains('on'));
    }

    /* 4. 键盘切换：→ 下一间、数字键 1 直达第一间 */
    const order1 = cardNames();
    const idx1 = order1.indexOf(currentName());
    const expectNext = order1[(idx1 + 1) % order1.length];
    key('ArrowRight');
    await sleep(50);
    check('→ 键切到下一间', currentName() === expectNext, '期望 ' + expectNext + '，实际 ' + currentName());
    key('1');
    await sleep(50);
    check('数字键 1 直达第一间', currentName() === cardNames()[0], currentName());

    /* 5. 未读红点：手动切换后跟随暂停 30s，别家事件只累计红点且不自动跳 */
    const pinned = currentName();
    await sleep(4500); // mock 每 0.65–1.4s 一条事件，别家厨房持续来事件
    const badges = [...document.querySelectorAll('#sw-cards .sw-card .badge')];
    const total = badges.reduce((s, b) => s + (parseInt(b.textContent, 10) || 0), 0);
    check('未读红点计数 > 0', badges.length > 0 && total > 0, badges.length + ' 枚红点，共 ' + total + ' 条未读');
    check('跟随暂停期间不自动跳', currentName() === pinned, '仍在 ' + currentName());

    /* 6. 订单票渲染 + 当前/全部过滤 */
    const curTickets = document.querySelectorAll('#feed .ticket').length;
    check('订单票已渲染（当前厨房）', curTickets > 0, curTickets + ' 张');
    const firstTicket = document.querySelector('#feed .ticket');
    check(
      '票卡结构完整（时间条/图标/厨师）',
      !!(firstTicket && firstTicket.querySelector('.tbar') && firstTicket.querySelector('.t-icon') &&
         firstTicket.querySelector('.t-chef') && firstTicket.querySelector('.t-chef').textContent)
    );
    document.getElementById('ff-all').click();
    await sleep(50);
    const allTickets = document.querySelectorAll('#feed .ticket').length;
    check('「全部」过滤票数 ≥ 当前厨房', allTickets >= curTickets && allTickets > 0,
      '当前 ' + curTickets + ' / 全部 ' + allTickets);
    check('全部模式显示厨房名', !!document.querySelector('#feed .ticket .t-kitchen'));
    document.getElementById('ff-current').click();
    await sleep(50);

    /* 7. 渲染器降级机制：3D 不可用时必须回退 stub 并显示徽章；3D 可用则直接用 3D */
    check('渲染器已创建', !!ctx.renderer);
    check(
      '降级机制生效（3D 不可用 → stub + 徽章）',
      usingStub ? !!document.getElementById('renderer-badge') : true,
      usingStub ? 'stub 模式' : '3D 模式'
    );

    /* 8. 控制台零报错（未捕获异常 / 未处理 Promise 拒绝） */
    check('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (err) {
    check('自测脚本自身执行', false, String((err && err.stack) || err));
  }

  const fails = out.filter((l) => l.indexOf('FAIL') === 0).length;
  out.unshift('SELFTEST ' + (fails === 0 ? 'ALL-PASS' : 'HAS-FAIL(' + fails + ')'));
  flush();
}
