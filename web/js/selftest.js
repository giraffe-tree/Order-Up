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
    /* 1. 切换条按项目分组 + 最近活跃排序
       （mock：codex-overcooked 项目含 k1/k4 两个会话，组内 k1 更新；随后 api-server、hugo-blog 两个单会话项目） */
    await sleep(300);
    const names0 = cardNames();
    check(
      '切换条按项目组 + lastTs 倒序',
      JSON.stringify(names0) === JSON.stringify(['codex-overcooked', '多端设计评审', 'api-server', 'hugo-blog']),
      names0.join(' > ')
    );
    check('初始展示第一间（最近活跃）', currentName() === 'codex-overcooked', currentName());

    /* 1b. 项目 → 会话两级分组：同项目多会话归一组并显示项目名标题；单会话项目保持扁平 */
    const groups = () => [...document.querySelectorAll('#sw-cards .sw-group')];
    check('项目分组容器渲染（3 个项目）', groups().length === 3, groups().length + ' 组');
    const grp = groups().find((g) => g.querySelector('.sw-group-name'));
    check(
      '多会话项目显示项目名标题（codex-overcooked，2 个会话）',
      !!grp && grp.querySelector('.sw-group-name').textContent === 'codex-overcooked' &&
        grp.querySelectorAll('.sw-card').length === 2,
      grp
        ? grp.querySelector('.sw-group-name').textContent + ' / ' + grp.querySelectorAll('.sw-card').length + ' 卡'
        : '没有找到组标题'
    );
    check(
      '单会话项目组不渲染组标题（扁平不臃肿）',
      groups().filter((g) => !g.querySelector('.sw-group-head')).length === 2,
      groups().filter((g) => !g.querySelector('.sw-group-head')).length + ' 个单会话组'
    );

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
    // 终态保持「全部」模式：便于截图目检厨房名小标签与出餐高亮描边（后续断言不依赖流水过滤）

    /* 7. 渲染器降级机制：3D 不可用时必须回退 stub 并显示徽章；3D 可用则直接用 3D */
    check('渲染器已创建', !!ctx.renderer);
    check(
      '降级机制生效（3D 不可用 → stub + 徽章）',
      usingStub ? !!document.getElementById('renderer-badge') : true,
      usingStub ? 'stub 模式' : '3D 模式'
    );

    /* 8. 音效链路：COSound 已加载、API 完整、顶栏音效按钮可见 */
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

    /* 9. 「已出餐」悬停明细：title 含各厨房出餐数（mock 快照 codex-overcooked / api-server 均有出餐） */
    const servedBox = document.getElementById('stat-served').closest('.stat');
    check(
      '「已出餐」title 明细（各厨房出餐数）',
      !!servedBox && /各厨房出餐/.test(servedBox.title) &&
        /codex-overcooked × \d+/.test(servedBox.title) && /api-server × \d+/.test(servedBox.title),
      servedBox ? servedBox.title.replace(/\n/g, '，') : '无 .stat 容器'
    );

    /* 10. 控制台零报错（未捕获异常 / 未处理 Promise 拒绝） */
    check('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (err) {
    check('自测脚本自身执行', false, String((err && err.stack) || err));
  }

  const fails = out.filter((l) => l.indexOf('FAIL') === 0).length;
  out.unshift('SELFTEST ' + (fails === 0 ? 'ALL-PASS' : 'HAS-FAIL(' + fails + ')'));
  flush();
}
