/* 自测脚本（仅 ?mock=1&selftest=1 时加载）：脚本化断言「项目标签 → 会话卡片」
   两级切换条的核心行为，结果写入 #selftest-result（PASS/FAIL 行），供无头 Chrome dump-dom 校验。 */

export async function run(ctx) {
  const { ui, state, usingStub, errors } = ctx;
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
  const tabs = () => [...document.querySelectorAll('#sw-tabs .sw-tab')];
  const tabNames = () =>
    tabs().map((t) => t.querySelector('.sw-tab-name').textContent);
  const findTab = (name) =>
    tabs().find((t) => t.querySelector('.sw-tab-name').textContent === name);
  const currentName = () => {
    const k = ui.currentKitchen();
    return k ? k.name : null;
  };
  const key = (k) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  try {
    /* 1. 项目标签排：按项目分组 + 组内 max lastTs 倒序；卡片条只展示当前项目的会话
       （mock：codex-overcooked 项目含 k1/k4 两个会话，组内 k1 更新；随后 api-server、hugo-blog、
       old-archive（占位厨房）三个单会话项目） */
    await sleep(300);
    check(
      '项目标签渲染（4 个项目，按最近活跃倒序）',
      JSON.stringify(tabNames()) === JSON.stringify(['codex-overcooked', 'api-server', 'hugo-blog', 'old-archive']),
      tabNames().join(' > ')
    );
    const tab0 = tabs()[0];
    check(
      '多会话项目标签显示会话数（2 会话）',
      !!tab0 && !!tab0.querySelector('.sw-tab-count') &&
        tab0.querySelector('.sw-tab-count').textContent === '2 会话',
      tab0 ? tab0.textContent : '没有标签'
    );
    check(
      '歇业项目标签置灰（hugo-blog 组内全部歇业）',
      !!findTab('hugo-blog') && findTab('hugo-blog').classList.contains('closed')
    );
    check(
      '卡片条只展示当前项目的会话（codex-overcooked 项目 2 张，组内 lastTs 倒序）',
      JSON.stringify(cardNames()) === JSON.stringify(['codex-overcooked', '多端设计评审']),
      cardNames().join(' > ')
    );
    check('初始展示第一间（最近活跃）', currentName() === 'codex-overcooked', currentName());
    check(
      '当前项目标签高亮 .on',
      !!findTab('codex-overcooked') && findTab('codex-overcooked').classList.contains('on')
    );

    /* 2. 点击项目标签切换项目：聚焦该项目并切到组内最近活跃的厨房 */
    const apiTab = findTab('api-server');
    check('找到 api-server 项目标签', !!apiTab);
    if (apiTab) {
      apiTab.click();
      await sleep(50);
      check('点击项目标签切换到该项目', currentName() === 'api-server', currentName());
      check(
        '卡片条只显示 api-server 项目的会话',
        JSON.stringify(cardNames()) === JSON.stringify(['api-server']),
        cardNames().join(',')
      );
      check(
        '项目标签高亮跟随切换',
        findTab('api-server').classList.contains('on') &&
          !findTab('codex-overcooked').classList.contains('on')
      );
    }

    /* 3. 项目内点击卡片切换会话 */
    findTab('codex-overcooked').click();
    await sleep(50);
    const cards = () => [...document.querySelectorAll('#sw-cards .sw-card')];
    let k4Card = null;
    cards().forEach((c) => {
      if (c.querySelector('.kname').textContent === '多端设计评审') k4Card = c;
    });
    check('标签切回后卡片条恢复该项目会话', !!k4Card && cardNames().length === 2, cardNames().join(','));
    if (k4Card) {
      k4Card.click();
      await sleep(50);
      check('项目内点击卡片切换会话', currentName() === '多端设计评审', currentName());
      // 注意：switchTo 会重渲染卡片条，旧元素引用已脱离 DOM，必须重新查询
      const onNow = document.querySelector('#sw-cards .sw-card.on');
      check('当前卡片高亮 .on',
        !!onNow && onNow.querySelector('.kname').textContent === '多端设计评审');
    }

    /* 4. 键盘切换：→ 与数字键按全局展示顺序（可跨项目，标签自动跟随当前厨房） */
    const order1 = ui.order();
    const idx1 = order1.indexOf(ui.currentId());
    const expectNextId = order1[(idx1 + 1) % order1.length];
    key('ArrowRight');
    await sleep(50);
    check('→ 键按全局展示顺序切到下一间', ui.currentId() === expectNextId,
      '期望 ' + expectNextId + '，实际 ' + ui.currentId());
    check(
      '切换后标签高亮自动跟随当前厨房所在项目',
      tabs().filter((t) => t.classList.contains('on')).length === 1 &&
        !!ui.currentKitchen() &&
        tabs().find((t) => t.classList.contains('on')).querySelector('.sw-tab-name').textContent ===
          (ui.currentKitchen().project || ui.currentKitchen().name)
    );
    // 与 key('1') 同一同步块内先取展示顺序第一名：jump 处理是同步的，
    // 若 sleep 后再读 ui.order()，期间 mock 事件已重排顺序，断言必然抖动
    const expectFirstId = ui.order()[0];
    key('1');
    await sleep(50);
    check('数字键 1 直达展示顺序第一间', ui.currentId() === expectFirstId, currentName());

    /* 5. 无自动跟随：手动切换后别家厨房持续来事件，当前厨房不被抢跳，只累计红点 */
    findTab('hugo-blog').click();
    await sleep(50);
    const pinned = currentName();
    check('手动切到 hugo-blog', pinned === 'hugo-blog', pinned);
    await sleep(4500); // mock 每 0.65–1.4s 一条事件，别家厨房持续来事件
    const tabBadges = [...document.querySelectorAll('#sw-tabs .sw-tab .badge')];
    const tabTotal = tabBadges.reduce((s, b) => s + (parseInt(b.textContent, 10) || 0), 0);
    check('未读红点在项目标签上聚合（> 0）', tabBadges.length > 0 && tabTotal > 0,
      tabBadges.length + ' 枚标签红点，共 ' + tabTotal + ' 条未读');
    check('无自动跟随：别家来事件不抢跳', currentName() === pinned, '仍在 ' + currentName());
    findTab('codex-overcooked').click();
    await sleep(50);
    const onCard1 = document.querySelector('#sw-cards .sw-card.on');
    check('切到某厨房后其卡片红点清零', !!onCard1 && !onCard1.querySelector('.badge'));

    /* 6. 多会话伸缩：单项目 10 个会话 —— 全渲染、横向滚动、当前卡片始终可见。
       全程同步执行（无 await），mock 事件无法插入，不怕被 ui.sync(state.kitchens) 冲掉 */
    const many = [];
    for (let i = 0; i < 10; i++) {
      many.push({
        id: 'big-k' + i, name: '大项目会话' + (i + 1), cwd: '/Users/dev/big-proj',
        project: 'big-proj', servedCount: 0, active: true, lastTs: Date.now() - i * 1000, chefs: []
      });
    }
    many.push({
      id: 'solo-x', name: 'solo-x', cwd: '/Users/dev/solo-x', project: 'solo-x',
      servedCount: 0, active: true, lastTs: Date.now() - 60000, chefs: []
    });
    ui.sync(many);
    check('单项目 10 个会话全部渲染为卡片', document.querySelectorAll('#sw-cards .sw-card').length === 10,
      document.querySelectorAll('#sw-cards .sw-card').length + ' 张');
    const bigTab = findTab('big-proj');
    check('多会话项目标签显示 10 会话',
      !!bigTab && bigTab.querySelector('.sw-tab-count').textContent === '10 会话',
      bigTab ? bigTab.textContent : '没有 big-proj 标签');
    const sc = document.getElementById('sw-cards');
    check('卡片条横向滚动（不挤爆切换条）', sc.scrollWidth > sc.clientWidth + 10,
      'scrollWidth ' + sc.scrollWidth + ' / clientWidth ' + sc.clientWidth);
    bigTab.click(); // 已聚焦的项目标签：再点在组内循环到下一个会话
    check('已聚焦的项目标签再点在组内循环', currentName() === '大项目会话2', currentName());
    key('9'); // 直达第 9 个会话（触发卡片条滚动）
    check('数字键直达后排的会话', currentName() === '大项目会话9', currentName());
    const onCard2 = document.querySelector('#sw-cards .sw-card.on');
    const r2 = onCard2.getBoundingClientRect();
    const cr = sc.getBoundingClientRect();
    check('当前会话卡片滚入可视区（始终可见）',
      r2.left >= cr.left - 1 && r2.right <= cr.right + 1,
      '卡片 ' + Math.round(r2.left) + '–' + Math.round(r2.right) +
      ' / 容器 ' + Math.round(cr.left) + '–' + Math.round(cr.right));
    /* 恢复 mock 数据，继续后续断言 */
    ui.sync(state.kitchens);
    check('恢复 mock 数据后切换条正常',
      !!currentName() && document.querySelectorAll('#sw-cards .sw-card').length >= 1,
      currentName());
    await sleep(50);

    /* 7. 订单票渲染 + 当前/全部过滤 */
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
    // 终态保持「全部」模式：便于截图目检厨房名小标签与出餐高亮描边（后续断言不依赖流水过滤）

    /* 8. 渲染器降级机制：3D 不可用时必须回退 stub 并显示徽章；3D 可用则直接用 3D */
    check('渲染器已创建', !!ctx.renderer);
    check(
      '降级机制生效（3D 不可用 → stub + 徽章）',
      usingStub ? !!document.getElementById('renderer-badge') : true,
      usingStub ? 'stub 模式' : '3D 模式'
    );

    /* 9. 音效链路：COSound 已加载、API 完整、顶栏音效按钮可见 */
    const snd = window.COSound;
    check('音效模块 COSound 已加载', !!snd);
    check(
      'COSound.play / setMuted 为函数',
      !!snd && typeof snd.play === 'function' && typeof snd.setMuted === 'function'
    );
    const btnSound = document.getElementById('btn-sound');
    check('顶栏音效按钮可见（不再 hidden）', !!btnSound && !btnSound.hidden);
    check(
      'COSound.setMuted 生效（muted 往返）',
      (() => {
        try {
          snd.setMuted(true);
          const on = snd.muted === true;
          snd.setMuted(false);
          return on && snd.muted === false;
        } catch (_) { return false; }
      })()
    );
    check(
      'COSound.play 静默安全（手势前调用不抛错）',
      (() => { try { snd.play('serve'); snd.play('chop'); return true; } catch (_) { return false; } })()
    );

    /* 10. 「已出餐」悬停明细：title 含各厨房出餐数（mock 快照 codex-overcooked / api-server 均有出餐） */
    const servedBox = document.getElementById('stat-served').closest('.stat');
    check(
      '「已出餐」title 明细（各厨房出餐数）',
      !!servedBox && /各厨房出餐/.test(servedBox.title) &&
        /codex-overcooked × \d+/.test(servedBox.title) && /api-server × \d+/.test(servedBox.title),
      servedBox ? servedBox.title.replace(/\n/g, '，') : '无 .stat 容器'
    );

    /* 10b. 占位厨房懒加载：old-archive 启动无厨师、卡片带「未加载」标记；
        点击切换后自动按需加载完整历史（mock loadKitchen 300ms），
        厨师/出餐补进 store，卡片摘掉标记（再次点击不重复拉取——lazy 已 false） */
    const archTab = findTab('old-archive');
    check('占位厨房出现在项目标签排（old-archive）', !!archTab);
    const k5 = () => state.kitchens.find((x) => x.id === 'mock-k5');
    const k5Card = () =>
      [...document.querySelectorAll('#sw-cards .sw-card')].find((c) =>
        c.querySelector('.kname') && c.querySelector('.kname').textContent === 'old-archive');
    check('占位厨房初始无厨师、lazy 标记在', !!k5() && k5().lazy === true && k5().chefs.length === 0);
    if (archTab) {
      archTab.click();
      await sleep(80);
      check('切换到占位厨房（空厨房正常渲染）', currentName() === 'old-archive', currentName());
      check('占位厨房卡片带「未加载」标记', !!k5Card() && !!k5Card().querySelector('.lazy-tag'));
      await sleep(600); // mock loadKitchen 延迟 300ms + 渲染余量
      check(
        '点击后按需加载完整历史（厨师到位、lazy 清除、出餐补入）',
        !!k5() && k5().lazy === false && k5().chefs.length >= 1 && (k5().servedCount || 0) >= 1,
        k5() ? ('chefs=' + k5().chefs.length + ' served=' + k5().servedCount + ' lazy=' + k5().lazy) : 'no k5'
      );
      check('加载后卡片摘掉「未加载」标记', !!k5Card() && !k5Card().querySelector('.lazy-tag'));
    }

    /* 11. 控制台零报错（未捕获异常 / 未处理 Promise 拒绝） */
    check('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (err) {
    check('自测脚本自身执行', false, String((err && err.stack) || err));
  }

  const fails = out.filter((l) => l.indexOf('FAIL') === 0).length;
  out.unshift('SELFTEST ' + (fails === 0 ? 'ALL-PASS' : 'HAS-FAIL(' + fails + ')'));
  flush();
}
