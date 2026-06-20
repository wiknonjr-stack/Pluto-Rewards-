require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 4000;

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  JWT_SECRET,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  FRONTEND_URL = "https://pluto-rewards.vercel.app",
  PLUTO_TOKEN_ADDRESS = "0x818b85e381b9f36b5a3f597788513633981c406e",
} = process.env;

const SPOTIFY_REDIRECT_URI = "https://pluto-rewards-production.up.railway.app/auth/spotify/callback";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

app.get("/", function (req, res) {
  res.json({ status: "Pluto Rewards backend running", token: PLUTO_TOKEN_ADDRESS });
});

app.get("/health", function (req, res) {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/robots.txt", function (req, res) {
  res.type("text/plain").send([
    "User-agent: GPTBot", "Disallow: /",
    "User-agent: ClaudeBot", "Disallow: /",
    "User-agent: anthropic-ai", "Disallow: /",
    "User-agent: CCBot", "Disallow: /",
    "User-agent: *", "Allow: /",
  ].join("\n"));
});

app.get("/auth/spotify", function (req, res) {
  var scopes = ["user-read-private", "user-read-email", "user-top-read"].join(" ");
  var params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: scopes,
  });
  res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

app.get("/auth/spotify/callback", async function (req, res) {
  var code = req.query.code;
  var error = req.query.error;
  if (error) return res.redirect(FRONTEND_URL + "?error=" + error);

  try {
    var tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString("base64"),
        },
      }
    );

    var accessToken = tokenRes.data.access_token;
    var spotifyId = "sp_" + crypto.createHash("sha256").update(accessToken.slice(0, 40)).digest("hex").slice(0, 16);

    var existing = await supabase.from("users").select("*").eq("spotify_id", spotifyId).single();
    var user = existing.data;

    if (!user) {
      var inserted = await supabase
        .from("users")
        .insert({ spotify_id: spotifyId, spotify_name: null, needs_username: true })
        .select()
        .single();
      if (inserted.error) {
        console.error("DB insert error:", inserted.error);
        return res.redirect(FRONTEND_URL + "?error=db_error");
      }
      user = inserted.data;
    }

    var jwtToken = jwt.sign(
      { id: user.id, spotify_id: user.spotify_id, role: user.role || "fan" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    var needsUsername = user.spotify_name ? "false" : "true";
    res.redirect(FRONTEND_URL + "?token=" + jwtToken + "&user_id=" + user.id + "&new_user=" + needsUsername);
  } catch (err) {
    console.error("Spotify auth error:", err.message);
    res.redirect(FRONTEND_URL + "?error=auth_failed");
  }
});

function requireAuth(req, res, next) {
  var authHeader = req.headers.authorization || "";
  var token = authHeader.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/auth/me", requireAuth, async function (req, res) {
  var result = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (result.error) return res.status(404).json({ error: "User not found" });
  res.json({ user: result.data });
});

function getTitle(score) {
  if (score >= 100) return { name: "Oracle", icon: "🌌" };
  if (score >= 60) return { name: "Pathfinder", icon: "🔥" };
  if (score >= 30) return { name: "Scout", icon: "🔭" };
  if (score >= 10) return { name: "Explorer", icon: "🌍" };
  return { name: "Newcomer", icon: "✨" };
}

function nextTitleInfo(score) {
  var tiers = [
    { name: "Newcomer", min: 0 },
    { name: "Explorer", min: 10 },
    { name: "Scout", min: 30 },
    { name: "Pathfinder", min: 60 },
    { name: "Oracle", min: 100 },
  ];
  var currentIdx = 0;
  for (var i = 0; i < tiers.length; i++) {
    if (score >= tiers[i].min) currentIdx = i;
  }
  var next = tiers[currentIdx + 1];
  if (!next) {
    return { next: null, pointsToNext: 0, progress: 100 };
  }
  var current = tiers[currentIdx];
  var progress = Math.round(((score - current.min) / (next.min - current.min)) * 100);
  return { next: next.name, pointsToNext: next.min - score, progress: progress };
  }
app.post("/api/set-username", requireAuth, async function (req, res) {
  var name = req.body.name;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: "Name too short" });
  var result = await supabase
    .from("users")
    .update({ spotify_name: name.trim(), needs_username: false })
    .eq("id", req.user.id)
    .select()
    .single();
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ user: result.data });
});

app.patch("/api/profile", requireAuth, async function (req, res) {
  var updates = {};
  if (req.body.wallet_address) updates.wallet_address = req.body.wallet_address;
  if (req.body.twitter_handle) updates.twitter_handle = req.body.twitter_handle;
  if (req.body.country) updates.country = req.body.country;
  var result = await supabase.from("users").update(updates).eq("id", req.user.id).select().single();
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ user: result.data });
});

app.post("/api/profile/avatar", requireAuth, async function (req, res) {
  var imageBase64 = req.body.image;
  if (!imageBase64) return res.status(400).json({ error: "No image provided" });
  try {
    var matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: "Invalid image format" });
    var mimeType = matches[1];
    var ext = mimeType.split("/")[1];
    var base64Data = matches[2];
    var buffer = Buffer.from(base64Data, "base64");
    if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: "Image too large (max 2MB)" });
    var fileName = req.user.id + "." + ext;
    var uploadRes = await supabase.storage.from("avatars").upload(fileName, buffer, { contentType: mimeType, upsert: true });
    if (uploadRes.error) return res.status(500).json({ error: uploadRes.error.message });
    var publicUrl = SUPABASE_URL + "/storage/v1/object/public/avatars/" + fileName;
    await supabase.from("users").update({ avatar_url: publicUrl }).eq("id", req.user.id);
    res.json({ avatar_url: publicUrl });
  } catch (err) {
    console.error("Avatar upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

var ALL_GENRES = ["Afrobeats","Amapiano","Hip-Hop","R&B","Pop","Latin","UK Drill","K-Pop","EDM","Gospel","Reggae","Indie","Country","Bollywood","Afropop","Highlife","Bongo Flava","J-Pop","Arabic Pop","OPM","Sertanejo","C-Pop","Salsa","Trap","Ndombolo","Rai","Turkish Pop","Classical","French Pop"];

app.get("/api/profile/me", requireAuth, async function (req, res) {
  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) return res.status(404).json({ error: "Not found" });
  var user = userRes.data;

  var genresRes = await supabase.from("campaign_participants").select("genre").eq("user_id", req.user.id);
  var uniqueGenres = Array.from(new Set((genresRes.data || []).map(function (p) { return p.genre; })));

  var score = user.discovery_score || 0;
  var streak = user.streak_days || 0;
  var longestStreak = Math.max(user.longest_streak || 0, streak);
  var flames = streak >= 100 ? "🔥🔥🔥" : streak >= 30 ? "🔥🔥" : streak >= 7 ? "🔥" : "";

  res.json({
    name: user.spotify_name || "Anonymous Fan",
    avatar_url: user.avatar_url || null,
    discovery_score: score,
    streak_days: streak,
    longest_streak: longestStreak,
    flames: flames,
    total_pluto: user.total_pluto || 0,
    wallet_address: user.wallet_address || null,
    country: user.country || null,
    member_since: user.created_at,
    title: getTitle(score),
    title_progress: nextTitleInfo(score),
    genres_explored: uniqueGenres,
    genres_count: uniqueGenres.length,
    total_genres: ALL_GENRES.length,
    all_genres: ALL_GENRES,
    campaigns_joined: (genresRes.data || []).length,
  });
});

app.get("/api/campaigns", async function (req, res) {
  var result = await supabase.from("campaigns").select("*").eq("status", "active").order("created_at", { ascending: false });
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ campaigns: result.data });
});

app.post("/api/campaigns", requireAuth, async function (req, res) {
  var body = req.body;
  var result = await supabase.from("campaigns").insert({
    operator_id: req.user.id, title: body.title, description: body.description,
    campaign_type: body.campaign_type, target_type: body.target_type,
    artist_name: body.artist_name, genre: body.genre, reward_pool: body.reward_pool,
    remaining_pool: body.reward_pool, duration: body.duration, ends_at: body.ends_at, status: "active",
  }).select().single();
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.status(201).json({ campaign: result.data });
});

app.post("/api/campaigns/:id/join", requireAuth, async function (req, res) {
  var wallet = req.body.wallet_address;
  var walletRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!wallet || !walletRegex.test(wallet)) return res.status(400).json({ error: "Valid wallet address required" });

  var campaignRes = await supabase.from("campaigns").select("*").eq("id", req.params.id).single();
  if (campaignRes.error || !campaignRes.data) return res.status(404).json({ error: "Campaign not found" });
  var campaign = campaignRes.data;

  await supabase.from("users").update({ wallet_address: wallet }).eq("id", req.user.id);

  var existingJoin = await supabase.from("campaign_participants").select("*").eq("campaign_id", req.params.id).eq("user_id", req.user.id).single();
  if (existingJoin.data) return res.json({ message: "Already joined", participant: existingJoin.data });

  var insertRes = await supabase.from("campaign_participants").insert({
    campaign_id: req.params.id, user_id: req.user.id, wallet_address: wallet, genre: campaign.genre,
  }).select().single();
  if (insertRes.error) return res.status(500).json({ error: insertRes.error.message });

  var priorGenres = await supabase.from("campaign_participants").select("genre").eq("user_id", req.user.id);
  var uniqueGenres = new Set((priorGenres.data || []).map(function (p) { return p.genre; }));
  var discoveryScore = uniqueGenres.size * 10;

  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  var user = userRes.data;
  var today = new Date().toISOString().split("T")[0];
  var newStreak = user.streak_days || 0;
  if (user.last_active_date !== today) {
    var yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    newStreak = (user.last_active_date === yesterday) ? newStreak + 1 : 1;
  }
  var longestStreak = Math.max(user.longest_streak || 0, newStreak);

  await supabase.from("users").update({
    discovery_score: discoveryScore, last_active_date: today, streak_days: newStreak, longest_streak: longestStreak,
  }).eq("id", req.user.id);

  res.json({
    message: "Joined campaign", participant: insertRes.data,
    discovery_score: discoveryScore, streak_days: newStreak, genres_explored: uniqueGenres.size,
  });
});

app.post("/api/waitlist", async function (req, res) {
  var email = req.body.email;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
  var result = await supabase.from("waitlist").upsert(
    { email: email, name: req.body.name, type: req.body.type || "fan", genre_interest: req.body.genre_interest },
    { onConflict: "email", ignoreDuplicates: true }
  ).select().single();
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.status(201).json({ message: "Added to waitlist", id: result.data ? result.data.id : null });
});
app.post("/api/checkin", requireAuth, async function (req, res) {
  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) return res.status(404).json({ error: "User not found" });
  var user = userRes.data;
  var today = new Date().toISOString().split("T")[0];

  if (user.last_active_date === today) {
    return res.json({ message: "Already checked in today", streak_days: user.streak_days || 0, reward: 0 });
  }

  var yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  var newStreak = (user.last_active_date === yesterday) ? (user.streak_days || 0) + 1 : 1;
  var longestStreak = Math.max(user.longest_streak || 0, newStreak);

  var reward = 100;
  if (newStreak % 30 === 0) reward = 5000;
  else if (newStreak % 7 === 0) reward = 1000;

  var mysteryRoll = Math.random();
  var mysteryBonus = 0;
  var mysteryBadge = false;
  var mysteryTier = null;
  if (mysteryRoll < 0.05) {
    mysteryTier = "rare";
    mysteryBadge = true;
    mysteryBonus = 0;
  } else if (mysteryRoll < 0.15) {
    mysteryTier = "big";
    mysteryBonus = 1000;
  } else if (mysteryRoll < 0.40) {
    mysteryTier = "medium";
    mysteryBonus = 300 + Math.floor(Math.random() * 200);
  } else if (mysteryRoll < 1.0) {
    mysteryTier = "small";
    mysteryBonus = 50 + Math.floor(Math.random() * 100);
  }

  var totalReward = reward + mysteryBonus;

  var updateRes = await supabase.from("users").update({
    streak_days: newStreak, last_active_date: today, longest_streak: longestStreak,
    total_pluto: (user.total_pluto || 0) + totalReward,
  }).eq("id", req.user.id);

  if (updateRes.error) {
    console.error("Checkin update error:", updateRes.error);
    return res.status(500).json({ error: "Failed to update checkin" });
  }

  var logRes = await supabase.from("checkins_log").insert({ user_id: req.user.id, reward: totalReward });
  if (logRes.error) console.error("Checkin log error:", logRes.error);

  if (mysteryBadge) {
    await supabase.from("user_badges").upsert(
      { user_id: req.user.id, badge_name: "Mystery Hunter" },
      { onConflict: "user_id,badge_name", ignoreDuplicates: true }
    );
  }

  res.json({
    message: "Checked in!", streak_days: newStreak, longest_streak: longestStreak,
    reward: reward, mystery_bonus: mysteryBonus, mystery_tier: mysteryTier, mystery_badge: mysteryBadge,
    total_reward: totalReward, total_pluto: (user.total_pluto || 0) + totalReward,
  });
});

async function snapshotRanks(type, sortField) {
  var result = await supabase.from("users").select("id").not("spotify_name", "is", null).order(sortField, { ascending: false }).limit(500);
  if (result.error) return;
  var today = new Date().toISOString().split("T")[0];
  var rows = result.data.map(function (u, i) {
    return { user_id: u.id, leaderboard_type: type, rank: i + 1, snapshot_date: today };
  });
  if (rows.length > 0) {
    await supabase.from("rank_snapshots").upsert(rows, { onConflict: "user_id,leaderboard_type,snapshot_date" });
  }
}

app.get("/api/leaderboard/:type", async function (req, res) {
  var sortField = "discovery_score";
  if (req.params.type === "streak") sortField = "streak_days";
  if (req.params.type === "earnings") sortField = "total_pluto";

  var result = await supabase
    .from("users")
    .select("id, spotify_name, avatar_url, discovery_score, streak_days, total_pluto")
    .not("spotify_name", "is", null)
    .order(sortField, { ascending: false })
    .limit(50);

  if (result.error) return res.status(500).json({ error: result.error.message });

  var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  var oldRanksRes = await supabase
    .from("rank_snapshots")
    .select("user_id, rank")
    .eq("leaderboard_type", req.params.type)
    .lte("snapshot_date", weekAgo)
    .order("snapshot_date", { ascending: false });

  var oldRankMap = {};
  (oldRanksRes.data || []).forEach(function (r) {
    if (!(r.user_id in oldRankMap)) oldRankMap[r.user_id] = r.rank;
  });

  var enriched = result.data.map(function (u, i) {
    var rank = i + 1;
    var oldRank = oldRankMap[u.id];
    var rankChange = oldRank ? oldRank - rank : null;
    return {
      rank: rank, id: u.id, name: u.spotify_name, avatar_url: u.avatar_url || null,
      discovery_score: u.discovery_score || 0, streak_days: u.streak_days || 0, total_pluto: u.total_pluto || 0,
      title: getTitle(u.discovery_score || 0), rank_change: rankChange,
      flames: (u.streak_days || 0) >= 100 ? "🔥🔥🔥" : (u.streak_days || 0) >= 30 ? "🔥🔥" : (u.streak_days || 0) >= 7 ? "🔥" : "",
    };
  });

  snapshotRanks(req.params.type, sortField);
  res.json({ leaderboard: enriched, type: req.params.type });
});

app.get("/api/leaderboard/:type/me", requireAuth, async function (req, res) {
  var sortField = "discovery_score";
  if (req.params.type === "streak") sortField = "streak_days";
  if (req.params.type === "earnings") sortField = "total_pluto";

  var all = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score, streak_days, total_pluto")
    .not("spotify_name", "is", null)
    .order(sortField, { ascending: false });

  if (all.error) return res.status(500).json({ error: all.error.message });

  var idx = all.data.findIndex(function (u) { return u.id === req.user.id; });
  var me = idx >= 0 ? all.data[idx] : null;
  var total = all.data.length;

  var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  var oldRankRes = await supabase
    .from("rank_snapshots")
    .select("rank")
    .eq("user_id", req.user.id)
    .eq("leaderboard_type", req.params.type)
    .lte("snapshot_date", weekAgo)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  var oldRank = oldRankRes.data ? oldRankRes.data.rank : null;
  var rankChange = (oldRank && idx >= 0) ? oldRank - (idx + 1) : null;
  var percentile = (total > 0 && idx >= 0) ? Math.round(((total - idx) / total) * 100) : 0;

  res.json({
    rank: idx >= 0 ? idx + 1 : null, total: total, percentile: percentile, rank_change: rankChange,
    me: me ? {
      name: me.spotify_name, discovery_score: me.discovery_score || 0,
      streak_days: me.streak_days || 0, total_pluto: me.total_pluto || 0,
      title: getTitle(me.discovery_score || 0),
    } : null,
  });
});

app.get("/api/hall-of-fame", async function (req, res) {
  var result = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score")
    .not("spotify_name", "is", null)
    .order("discovery_score", { ascending: false })
    .limit(10);
  if (result.error) return res.status(500).json({ error: result.error.message });
  var ranked = result.data.map(function (u, i) {
    return { rank: i + 1, name: u.spotify_name, discovery_score: u.discovery_score || 0 };
  });
  res.json({ hall_of_fame: ranked });
});
app.get("/api/users/search", async function (req, res) {
  var q = req.query.q || "";
  if (q.length < 2) return res.json({ users: [] });
  var result = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score, streak_days, avatar_url")
    .ilike("spotify_name", "%" + q + "%")
    .limit(10);
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ users: result.data });
});

app.post("/api/follow/:userId", requireAuth, async function (req, res) {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "Cannot follow yourself" });
  var result = await supabase.from("follows").insert({
    follower_id: req.user.id, following_id: req.params.userId,
  }).select().single();
  if (result.error) {
    if (result.error.code === "23505") return res.json({ message: "Already following" });
    return res.status(500).json({ error: result.error.message });
  }
  res.status(201).json({ message: "Followed" });
});

app.delete("/api/follow/:userId", requireAuth, async function (req, res) {
  var result = await supabase.from("follows").delete().eq("follower_id", req.user.id).eq("following_id", req.params.userId);
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ message: "Unfollowed" });
});

app.get("/api/friends", requireAuth, async function (req, res) {
  var followsRes = await supabase.from("follows").select("following_id").eq("follower_id", req.user.id);
  if (followsRes.error) return res.status(500).json({ error: followsRes.error.message });
  var ids = followsRes.data.map(function (f) { return f.following_id; });

  var followersRes = await supabase.from("follows").select("follower_id", { count: "exact" }).eq("following_id", req.user.id);
  var followersCount = followersRes.count || 0;

  if (ids.length === 0) return res.json({ friends: [], followers_count: followersCount, following_count: 0 });

  var usersRes = await supabase.from("users").select("id, spotify_name, discovery_score, streak_days, avatar_url, total_pluto").in("id", ids);
  if (usersRes.error) return res.status(500).json({ error: usersRes.error.message });

  var friends = usersRes.data.map(function (u) {
    return {
      id: u.id, name: u.spotify_name || "Anonymous Fan", avatar_url: u.avatar_url || null,
      discovery_score: u.discovery_score || 0, streak_days: u.streak_days || 0,
      total_pluto: u.total_pluto || 0, title: getTitle(u.discovery_score || 0),
    };
  });
  res.json({ friends: friends, followers_count: followersCount, following_count: ids.length });
});

app.get("/api/recap", requireAuth, async function (req, res) {
  var period = req.query.period === "month" ? 30 : 7;
  var since = new Date(Date.now() - period * 86400000).toISOString();

  var checkinsRes = await supabase.from("checkins_log").select("reward, created_at").eq("user_id", req.user.id).gte("created_at", since);
  var joinsRes = await supabase.from("campaign_participants").select("genre, created_at").eq("user_id", req.user.id).gte("created_at", since);

  if (checkinsRes.error || joinsRes.error) return res.status(500).json({ error: "Failed to load recap" });

  var totalEarned = checkinsRes.data.reduce(function (sum, c) { return sum + (c.reward || 0); }, 0);
  var uniqueGenres = new Set(joinsRes.data.map(function (j) { return j.genre; }));

  res.json({
    period: period === 30 ? "month" : "week", checkins: checkinsRes.data.length,
    pluto_earned: totalEarned, campaigns_joined: joinsRes.data.length, new_genres: uniqueGenres.size,
  });
});

app.get("/api/community/stats", async function (req, res) {
  var usersRes = await supabase.from("users").select("id, total_pluto, discovery_score", { count: "exact" });
  var campaignsRes = await supabase.from("campaigns").select("id", { count: "exact" }).eq("status", "active");
  var checkinsRes = await supabase.from("checkins_log").select("reward", { count: "exact" });
  var joinsRes = await supabase.from("campaign_participants").select("id", { count: "exact" });

  var totalPluto = (usersRes.data || []).reduce(function (sum, u) { return sum + (u.total_pluto || 0); }, 0);
  var totalCheckinRewards = (checkinsRes.data || []).reduce(function (sum, c) { return sum + (c.reward || 0); }, 0);

  res.json({
    total_fans: usersRes.count || 0, active_campaigns: campaignsRes.count || 0,
    total_checkins: checkinsRes.count || 0, total_joins: joinsRes.count || 0,
    total_pluto_distributed: totalPluto + totalCheckinRewards,
  });
});

app.get("/api/quests/daily", async function (req, res) {
  var dayIndex = new Date().getDate() % 5;
  var quests = [
    { title: "Genre Hopper", desc: "Join a campaign in a genre you haven't tried yet.", reward: 500, icon: "🌍" },
    { title: "Streak Keeper", desc: "Check in today to keep your streak alive.", reward: 100, icon: "🔥" },
    { title: "Social Butterfly", desc: "Follow 2 new fans on Pluto.", reward: 300, icon: "🤝" },
    { title: "Deep Diver", desc: "Join any Top Listener campaign.", reward: 400, icon: "🎯" },
    { title: "Profile Polish", desc: "Upload an avatar to your profile.", reward: 200, icon: "✨" },
  ];
  res.json({ quest: quests[dayIndex], date: new Date().toISOString().split("T")[0] });
});
app.get("/api/badges/me", requireAuth, async function (req, res) {
  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) return res.status(404).json({ error: "Not found" });
  var user = userRes.data;

  var genresRes = await supabase.from("campaign_participants").select("genre").eq("user_id", req.user.id);
  var uniqueGenres = new Set((genresRes.data || []).map(function (p) { return p.genre; }));

  var specialBadgesRes = await supabase.from("user_badges").select("badge_name").eq("user_id", req.user.id);
  var specialBadges = (specialBadgesRes.data || []).map(function (b) { return b.badge_name; });

  var founderCutoffRes = await supabase.from("users").select("id").order("created_at", { ascending: true }).limit(500);
  var founderIds = (founderCutoffRes.data || []).map(function (u) { return u.id; });
  var isFounder = founderIds.indexOf(req.user.id) !== -1;

  var badges = [];
  badges.push({ name: "First Discovery", icon: "🌱", earned: (user.discovery_score || 0) >= 10, requirement: "Earn 10 Discovery Score" });
  badges.push({ name: "Genre Explorer", icon: "🌍", earned: uniqueGenres.size >= 5, requirement: "Explore 5 genres" });
  badges.push({ name: "World Traveler", icon: "🗺️", earned: uniqueGenres.size >= 15, requirement: "Explore 15 genres" });
  badges.push({ name: "Week Warrior", icon: "🔥", earned: (user.streak_days || 0) >= 7, requirement: "7-day streak" });
  badges.push({ name: "Month Master", icon: "🏅", earned: (user.streak_days || 0) >= 30, requirement: "30-day streak" });
  badges.push({ name: "Century Streak", icon: "💯", earned: (user.streak_days || 0) >= 100, requirement: "100-day streak" });
  badges.push({ name: "Mystery Hunter", icon: "🎁", earned: specialBadges.indexOf("Mystery Hunter") !== -1, requirement: "Find a rare Mystery Drop" });
  badges.push({ name: "Founding Fan", icon: "👑", earned: isFounder, requirement: "Be one of the first 500 Pluto users" });

  res.json({ badges: badges, total_possible: badges.length, total_earned: badges.filter(function (b) { return b.earned; }).length });
});

app.listen(PORT, function () {
  console.log("Pluto Rewards backend running on port " + PORT);
  console.log("Spotify redirect: " + SPOTIFY_REDIRECT_URI);
});
