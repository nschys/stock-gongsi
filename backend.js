// 데이터 계층. 화면(app.js)은 이 인터페이스만 씀:
//   init(inviteCode) -> { room, me, needsNickname }
//   join(nick), listPosts(), listReactions(postIds), latestCloses(posts),
//   searchSymbols(market, q), createPost(p), deletePost(id),
//   toggleReaction(postId, kind, on), subscribe(onChange)

function makeSupabaseBackend(cfg) {
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, storageKey: "gongsi-auth" },
  });
  let room = null;
  let me = null;
  let invite = null;

  const must = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    demo: false,

    async init(inviteCode) {
      invite = inviteCode;
      let { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const res = await sb.auth.signInAnonymously();
        if (res.error) throw new Error("익명 로그인 실패: " + res.error.message);
        session = res.data.session;
      }
      me = { id: session.user.id, nickname: null };
      const nick = localStorage.getItem("gongsi.nick");
      if (!nick) return { room: null, me, needsNickname: true };
      await this.join(nick);
      return { room, me, needsNickname: false };
    },

    async join(nick) {
      const { data, error } = await sb.rpc("join_room", { code: invite, nick });
      if (error) {
        if (/invalid invite/.test(error.message)) throw new Error("초대 코드가 올바르지 않아요. 받은 링크를 다시 열어 주세요.");
        throw new Error(error.message);
      }
      room = data;
      me.nickname = nick;
      localStorage.setItem("gongsi.nick", nick);
      return room;
    },

    async listPosts() {
      return must(await sb.from("posts").select("*").eq("room_id", room.id)
        .order("created_at", { ascending: false }).limit(300)).reverse();
    },

    async listReactions(postIds) {
      if (!postIds.length) return [];
      return must(await sb.from("reactions").select("post_id,user_id,kind,nickname").in("post_id", postIds));
    },

    async latestCloses(posts) {
      const syms = [...new Set(posts.map((p) => p.symbol))];
      if (!syms.length) return [];
      return must(await sb.from("latest_closes").select("*").in("symbol", syms));
    },

    async searchSymbols(market, q) {
      q = q.replace(/[%,()]/g, "").trim();
      if (!q) return [];
      return must(await sb.from("symbols").select("market,symbol,name,exchange")
        .eq("market", market)
        .or(`name.ilike.%${q}%,symbol.ilike.${q}%`)
        .order("name").limit(8));
    },

    async createPost(p) {
      must(await sb.from("posts").insert({ ...p, room_id: room.id }));
    },

    async deletePost(id) {
      must(await sb.from("posts").delete().eq("id", id));
    },

    async toggleReaction(postId, kind, on) {
      if (on) must(await sb.from("reactions").insert({ post_id: postId, kind }));
      else must(await sb.from("reactions").delete().match({ post_id: postId, kind, user_id: me.id }));
    },

    subscribe(onChange) {
      sb.channel("room-" + room.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `room_id=eq.${room.id}` }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, onChange)
        .subscribe();
      // 실시간 연결이 끊겨도 1분마다 새로고침
      setInterval(onChange, 60000);
    },
  };
}

// ── 데모: 서버 없이 화면을 확인하는 용도. 새로고침하면 초기화됨 ──
function makeDemoBackend() {
  const SYMBOLS = [
    ["KR", "005930", "삼성전자", "KOSPI"], ["KR", "000660", "SK하이닉스", "KOSPI"],
    ["KR", "035420", "NAVER", "KOSPI"], ["KR", "035720", "카카오", "KOSPI"],
    ["KR", "247540", "에코프로비엠", "KOSDAQ"], ["KR", "069500", "KODEX 200", "ETF"],
    ["KR", "360750", "TIGER 미국S&P500", "ETF"],
    ["US", "AAPL", "Apple Inc.", "NASDAQ"], ["US", "NVDA", "NVIDIA Corporation", "NASDAQ"],
    ["US", "TSLA", "Tesla, Inc.", "NASDAQ"], ["US", "QQQ", "Invesco QQQ Trust", "NASDAQ"],
    ["US", "KO", "Coca-Cola Company", "NYSE"],
  ].map(([market, symbol, name, exchange]) => ({ market, symbol, name, exchange }));
  const CLOSES = {
    "KR:005930": 190200, "KR:000660": 512000, "KR:035720": 38150, "KR:069500": 80065,
    "US:NVDA": 182.4, "US:TSLA": 402.15, "US:AAPL": 268.81,
  };
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const me = { id: "me", nickname: null };
  let seq = 10;
  const posts = [
    { id: 1, user_id: "u1", nickname: "존버왕", market: "KR", symbol: "005930", name: "삼성전자", side: "BUY", price: 172000, qty: 30, created_at: ago(60 * 26) },
    { id: 2, user_id: "u2", nickname: "단타요정", market: "US", symbol: "NVDA", name: "NVIDIA Corporation", side: "SELL", price: 171.2, qty: 15, created_at: ago(60 * 20) },
    { id: 3, user_id: "u3", nickname: "물타기장인", market: "KR", symbol: "035720", name: "카카오", side: "BUY", price: 41500, qty: 100, created_at: ago(60 * 5) },
    { id: 4, user_id: "u2", nickname: "단타요정", market: "US", symbol: "TSLA", name: "Tesla, Inc.", side: "BUY", price: 388.5, qty: 3.5, created_at: ago(40) },
    { id: 5, user_id: "u1", nickname: "존버왕", market: "KR", symbol: "000660", name: "SK하이닉스", side: "SELL", price: 540000, qty: 5, created_at: ago(12) },
    { id: 6, user_id: "u3", nickname: "물타기장인", market: "KR", symbol: "247540", name: "에코프로비엠", side: "BUY", price: 128300, qty: 10, created_at: ago(3) },
  ];
  const reactions = [
    { post_id: 1, user_id: "u2", kind: "envy", nickname: "단타요정" },
    { post_id: 1, user_id: "u3", kind: "envy", nickname: "물타기장인" },
    { post_id: 2, user_id: "u1", kind: "fool", nickname: "존버왕" },
    { post_id: 2, user_id: "u3", kind: "fool", nickname: "물타기장인" },
    { post_id: 3, user_id: "u1", kind: "why", nickname: "존버왕" },
    { post_id: 3, user_id: "u2", kind: "why", nickname: "단타요정" },
    { post_id: 3, user_id: "u2", kind: "fool", nickname: "단타요정" },
    { post_id: 5, user_id: "u3", kind: "envy", nickname: "물타기장인" },
  ];
  let notify = () => {};
  const tick = () => setTimeout(() => notify(), 0);

  return {
    demo: true,
    async init() {
      me.nickname = localStorage.getItem("gongsi.demo.nick");
      return { room: { name: "매매공시방 (데모)" }, me, needsNickname: !me.nickname };
    },
    async join(nick) {
      me.nickname = nick;
      localStorage.setItem("gongsi.demo.nick", nick);
      posts.concat(reactions).forEach((r) => { if (r.user_id === "me") r.nickname = nick; });
    },
    async listPosts() { return posts.map((p) => ({ ...p })); },
    async listReactions() { return reactions.map((r) => ({ ...r })); },
    async latestCloses() {
      return Object.entries(CLOSES).map(([k, close]) => {
        const [market, symbol] = k.split(":");
        return { market, symbol, close, trade_date: yday };
      });
    },
    async searchSymbols(market, q) {
      q = q.trim().toLowerCase();
      if (!q) return [];
      return SYMBOLS.filter((s) => s.market === market &&
        (s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().startsWith(q))).slice(0, 8);
    },
    async createPost(p) {
      posts.push({ ...p, id: ++seq, user_id: "me", nickname: me.nickname, created_at: new Date().toISOString() });
      tick();
    },
    async deletePost(id) {
      const i = posts.findIndex((p) => p.id === id && p.user_id === "me");
      if (i >= 0) posts.splice(i, 1);
      tick();
    },
    async toggleReaction(postId, kind, on) {
      const i = reactions.findIndex((r) => r.post_id === postId && r.kind === kind && r.user_id === "me");
      if (on && i < 0) reactions.push({ post_id: postId, kind, user_id: "me", nickname: me.nickname });
      if (!on && i >= 0) reactions.splice(i, 1);
      tick();
    },
    subscribe(onChange) { notify = onChange; },
  };
}
