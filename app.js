(() => {
  const $ = (id) => document.getElementById(id);
  const REACTIONS = [
    { kind: "why", label: "왜삼?", emoji: "🤔" },
    { kind: "envy", label: "부럽!", emoji: "🤩" },
    { kind: "fool", label: "바보ㅋㅋ", emoji: "🤪" },
  ];

  const state = {
    api: null, me: null, room: null,
    posts: [], reactions: [], closes: new Map(),
    market: "KR", side: "BUY", picked: null,
  };

  // ── 숫자·날짜 표시 ──────────────────────────────────
  const fmtPrice = (v, market) => market === "KR"
    ? "₩" + Math.round(v).toLocaleString("ko-KR")
    : "$" + (+v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtSigned = (v, market) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmtPrice(Math.abs(v), market);
  const fmtPct = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(2) + "%";
  const fmtQty = (v) => (+v).toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  const fmtShortDate = (d) => { const [, m, day] = d.split("-"); return `${+m}/${+day}`; };
  const dir = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
  const parseNum = (s) => {
    const n = Number(String(s).replace(/[,\s₩$]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // 최근 종가 대비 평가.
  // 매수: 산 가격 대비 지금 얼마나 올랐나 = 손익.
  // 매도: 판 가격 대비 그 뒤 얼마나 움직였나. 오르면 놓친 돈, 내리면 피한 손실.
  function evaluate(post) {
    const c = state.closes.get(post.market + ":" + post.symbol);
    if (!c) return null;
    const close = +c.close, price = +post.price, qty = +post.qty;
    const move = close / price - 1;
    const amount = (close - price) * qty;
    return { close, date: c.trade_date, move, amount };
  }

  function evalHtml(post) {
    const e = evaluate(post);
    if (!e) return `<div class="eval pending">종가 수집 전 · 다음 업데이트 후 계산돼요</div>`;
    const base = `<span class="eval-base">${fmtShortDate(e.date)} 종가 ${fmtPrice(e.close, post.market)}</span>`;
    if (post.side === "BUY") {
      return `<div class="eval ${dir(e.move)}">
        <span class="eval-main">${fmtPct(e.move)} <b>${fmtSigned(e.amount, post.market)}</b></span>${base}</div>`;
    }
    const verdict = e.move > 0 ? `판 뒤 올랐어요 · 놓친 돈 <b>${fmtPrice(e.amount, post.market)}</b>`
      : e.move < 0 ? `판 뒤 내렸어요 · 피한 손실 <b>${fmtPrice(-e.amount, post.market)}</b>`
      : "판 가격 그대로예요";
    return `<div class="eval ${dir(e.move)}">
      <span class="eval-main">${fmtPct(e.move)} ${verdict}</span>${base}</div>`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── 피드 그리기 ────────────────────────────────────
  function render() {
    const feed = $("feed");
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const byPost = new Map();
    for (const r of state.reactions) {
      if (!byPost.has(r.post_id)) byPost.set(r.post_id, []);
      byPost.get(r.post_id).push(r);
    }
    let lastDay = "";
    const parts = [];
    for (const p of state.posts) {
      const day = fmtDay(p.created_at);
      if (day !== lastDay) { parts.push(`<div class="day">${day}</div>`); lastDay = day; }
      const mine = p.user_id === state.me.id;
      const rs = byPost.get(p.id) || [];
      const total = +p.price * +p.qty;
      const buttons = REACTIONS.map(({ kind, label, emoji }) => {
        const who = rs.filter((r) => r.kind === kind);
        const on = who.some((r) => r.user_id === state.me.id);
        const names = who.map((r) => r.nickname).join(", ");
        return `<button type="button" class="react ${on ? "on" : ""}" data-post="${p.id}" data-kind="${kind}"
          ${names ? `title="${esc(names)}"` : ""} aria-pressed="${on}">
          ${emoji} ${label}${who.length ? ` <span class="cnt">${who.length}</span>` : ""}</button>`;
      }).join("");
      const whoLine = rs.length ? `<div class="who">${REACTIONS.map(({ kind, emoji }) => {
        const n = rs.filter((r) => r.kind === kind).map((r) => esc(r.nickname));
        return n.length ? `${emoji} ${n.join(", ")}` : "";
      }).filter(Boolean).join(" · ")}</div>` : "";
      parts.push(`<article class="post ${mine ? "mine" : ""}" data-id="${p.id}">
        <div class="post-head">
          <span class="nick">${esc(p.nickname)}</span>
          <span class="time">${fmtTime(p.created_at)}</span>
          ${mine ? `<button type="button" class="del" data-del="${p.id}" aria-label="공시 삭제">삭제</button>` : ""}
        </div>
        <div class="post-body">
          <div class="line1">
            <span class="side-tag ${p.side === "BUY" ? "buy" : "sell"}">${p.side === "BUY" ? "매수" : "매도"}</span>
            <span class="flag">${p.market === "KR" ? "🇰🇷" : "🇺🇸"}</span>
            <span class="stock">${esc(p.name)}</span>
            <span class="code">${esc(p.symbol)}</span>
          </div>
          <div class="line2">${fmtPrice(p.price, p.market)} × ${fmtQty(p.qty)}주
            <span class="total">= ${fmtPrice(total, p.market)}</span></div>
          ${evalHtml(p)}
        </div>
        <div class="reacts">${buttons}</div>
        ${whoLine}
      </article>`);
    }
    feed.querySelectorAll(".day, .post").forEach((n) => n.remove());
    feed.insertAdjacentHTML("beforeend", parts.join(""));
    $("emptyMsg").hidden = state.posts.length > 0;
    if (nearBottom || !render.done) feed.scrollTop = feed.scrollHeight;
    render.done = true;
  }

  let reloading = null;
  async function reload() {
    if (reloading) return reloading;
    reloading = (async () => {
      try {
        const posts = await state.api.listPosts();
        const [reactions, closes] = await Promise.all([
          state.api.listReactions(posts.map((p) => p.id)),
          state.api.latestCloses(posts),
        ]);
        state.posts = posts;
        state.reactions = reactions;
        state.closes = new Map(closes.map((c) => [c.market + ":" + c.symbol, c]));
        render();
      } catch (e) {
        toast("불러오기 실패: " + e.message);
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  }
  let debounce;
  const scheduleReload = () => { clearTimeout(debounce); debounce = setTimeout(reload, 250); };

  // ── 반응·삭제 ─────────────────────────────────────
  $("feed").addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".react");
    if (btn) {
      const postId = +btn.dataset.post, kind = btn.dataset.kind;
      const on = !btn.classList.contains("on");
      // 먼저 화면에 반영하고 서버에 저장
      if (on) state.reactions.push({ post_id: postId, kind, user_id: state.me.id, nickname: state.me.nickname });
      else state.reactions = state.reactions.filter((r) => !(r.post_id === postId && r.kind === kind && r.user_id === state.me.id));
      render();
      try { await state.api.toggleReaction(postId, kind, on); }
      catch (e) { toast("반응 저장 실패: " + e.message); }
      scheduleReload();
      return;
    }
    const del = ev.target.closest("[data-del]");
    if (del && confirm("이 공시를 삭제할까요?")) {
      try { await state.api.deletePost(+del.dataset.del); } catch (e) { toast("삭제 실패: " + e.message); }
      scheduleReload();
    }
  });

  // ── 입력창 ────────────────────────────────────────
  function setSeg(attr, value) {
    document.querySelectorAll(`[data-${attr}]`).forEach((b) =>
      b.classList.toggle("on", b.dataset[attr] === value));
  }
  document.querySelectorAll("[data-market]").forEach((b) => b.addEventListener("click", () => {
    state.market = b.dataset.market;
    setSeg("market", state.market);
    state.picked = null;
    $("symbolInput").value = "";
    $("priceInput").placeholder = state.market === "KR" ? "단가 (원)" : "단가 ($)";
    hideSuggest();
    $("symbolInput").focus();
  }));
  document.querySelectorAll("[data-side]").forEach((b) => b.addEventListener("click", () => {
    state.side = b.dataset.side;
    setSeg("side", state.side);
    $("submitBtn").classList.toggle("sell", state.side === "SELL");
  }));

  let searchTimer, searchSeq = 0, suggestions = [], active = -1;
  function hideSuggest() { $("suggest").hidden = true; suggestions = []; active = -1; }
  function showSuggest() {
    const ul = $("suggest");
    if (!suggestions.length) { ul.hidden = true; return; }
    ul.innerHTML = suggestions.map((s, i) => `<li data-i="${i}" class="${i === active ? "active" : ""}">
      <span>${esc(s.name)}</span><span class="muted">${esc(s.symbol)} · ${esc(s.exchange)}</span></li>`).join("");
    ul.hidden = false;
  }
  function pick(s) {
    state.picked = s;
    $("symbolInput").value = s.name;
    hideSuggest();
    $("priceInput").focus();
  }
  $("symbolInput").addEventListener("input", () => {
    state.picked = null;
    clearTimeout(searchTimer);
    const q = $("symbolInput").value;
    searchTimer = setTimeout(async () => {
      const my = ++searchSeq;
      try {
        const rows = await state.api.searchSymbols(state.market, q);
        if (my !== searchSeq) return;
        suggestions = rows; active = rows.length ? 0 : -1;
        showSuggest();
      } catch (e) { toast("종목 검색 실패: " + e.message); }
    }, 180);
  });
  $("symbolInput").addEventListener("keydown", (ev) => {
    if ($("suggest").hidden) return;
    if (ev.key === "ArrowDown") { active = Math.min(active + 1, suggestions.length - 1); showSuggest(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = Math.max(active - 1, 0); showSuggest(); ev.preventDefault(); }
    else if (ev.key === "Enter" && active >= 0) { pick(suggestions[active]); ev.preventDefault(); }
    else if (ev.key === "Escape") hideSuggest();
  });
  $("suggest").addEventListener("mousedown", (ev) => {
    const li = ev.target.closest("li");
    if (li) { ev.preventDefault(); pick(suggestions[+li.dataset.i]); }
  });
  $("symbolInput").addEventListener("blur", () => setTimeout(hideSuggest, 150));

  function formError(msg) {
    const m = $("formMsg");
    m.textContent = msg; m.hidden = !msg;
  }

  $("composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    formError("");
    const typed = $("symbolInput").value.trim();
    let s = state.picked;
    if (!s && typed) {
      // 목록에서 안 골랐으면 코드를 직접 입력한 것으로 봄 (종목 목록에 없는 신규 상장 등)
      const code = typed.toUpperCase();
      const ok = state.market === "KR" ? /^[0-9A-Z]{6}$/.test(code) : /^[A-Z][A-Z0-9.\-]{0,9}$/.test(code);
      if (!ok) return formError("목록에서 종목을 골라 주세요. 목록에 없으면 종목코드(예: 005930, AAPL)를 입력하세요.");
      s = { symbol: code, name: code };
    }
    if (!s) return formError("종목을 입력하세요.");
    const price = parseNum($("priceInput").value);
    const qty = parseNum($("qtyInput").value);
    if (!price) return formError("단가를 숫자로 입력하세요.");
    if (!qty) return formError("수량을 숫자로 입력하세요.");

    $("submitBtn").disabled = true;
    try {
      await state.api.createPost({
        market: state.market, symbol: s.symbol, name: s.name, side: state.side, price, qty,
      });
      state.picked = null;
      ["symbolInput", "priceInput", "qtyInput"].forEach((id) => ($(id).value = ""));
      render.done = false; // 내 글은 항상 맨 아래로 스크롤
      await reload();
    } catch (e) {
      formError("등록 실패: " + e.message);
    } finally {
      $("submitBtn").disabled = false;
    }
  });

  // ── 닉네임·초대 ───────────────────────────────────
  function askNickname(current) {
    return new Promise((resolve) => {
      const d = $("nickDialog");
      $("nickInput").value = current || "";
      d.showModal();
      $("nickForm").onsubmit = (ev) => {
        const v = $("nickInput").value.trim();
        if (!v) { ev.preventDefault(); return; }
        resolve(v);
      };
      d.oncancel = (ev) => { if (!current) ev.preventDefault(); else resolve(null); };
    });
  }
  $("nickBtn").addEventListener("click", async () => {
    const nick = await askNickname(state.me.nickname);
    if (!nick || nick === state.me.nickname) return;
    try {
      await state.api.join(nick);
      $("nickBtn").textContent = nick;
      toast("닉네임을 바꿨어요. 앞으로 쓰는 글부터 적용돼요.");
    } catch (e) { toast(e.message); }
  });
  $("inviteBtn").addEventListener("click", async () => {
    const url = location.href;
    try { await navigator.clipboard.writeText(url); toast("초대 링크를 복사했어요."); }
    catch { prompt("이 주소를 친구에게 보내세요", url); }
  });

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }
  function fatal(msg) {
    $("fatal").innerHTML = `<div><h2>입장할 수 없어요</h2><p>${esc(msg)}</p></div>`;
    $("fatal").hidden = false;
    $("composer").hidden = true;
  }

  // ── 시작 ──────────────────────────────────────────
  async function start() {
    const cfg = window.GONGSI_CONFIG || {};
    const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || new URLSearchParams(location.search).has("demo");
    state.api = demo ? makeDemoBackend() : makeSupabaseBackend(cfg);
    $("demoBadge").hidden = !demo;
    $("priceInput").placeholder = "단가 (원)";

    const code = location.hash.replace(/^#/, "").trim();
    if (!demo && !code) return fatal("초대 링크로만 들어올 수 있어요. 방에 있는 친구에게 링크를 받아 주세요.");

    try {
      let res = await state.api.init(code);
      if (res.needsNickname) {
        const nick = await askNickname("");
        await state.api.join(nick);
        res = await state.api.init(code);
      }
      state.me = res.me;
      state.room = res.room;
      $("roomName").textContent = res.room.name;
      document.title = res.room.name;
      $("nickBtn").textContent = state.me.nickname;
      await reload();
      state.api.subscribe(scheduleReload);
    } catch (e) {
      if (/초대 코드/.test(e.message)) localStorage.removeItem("gongsi.nick");
      fatal(e.message);
    }
  }
  // 열린 상태에서 다른 초대 링크를 붙여넣으면 처음부터 다시 시작
  window.addEventListener("hashchange", () => location.reload());
  start();
})();
