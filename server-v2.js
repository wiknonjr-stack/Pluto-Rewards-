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
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Pluto Rewards backend running", token: PLUTO_TOKEN_ADDRESS });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "User-agent: GPTBot",
    "Disallow: /",
    "User-agent: ClaudeBot",
    "Disallow: /",
    "User-agent: anthropic-ai",
    "Disallow: /",
    "User-agent: CCBot",
    "Disallow: /",
    "User-agent: *",
    "Allow: /",
  ].join("\n"));
});

app.get("/auth/spotify", (req, res) => {
  const scopes = ["user-read-private", "user-read-email", "user-top-read"].join(" ");
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: scopes,
  });
  res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

app.get("/auth/spotify/callback", async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;

  if (error) {
    return res.redirect(FRONTEND_URL + "?error=" + error);
  }

  try {
    const tokenRes = await axios.post(
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

    const accessToken = tokenRes.data.access_token;
    const spotifyId = "sp_" + crypto.createHash("sha256").update(accessToken.slice(0, 40)).digest("hex").slice(0, 16);

    const existing = await supabase
      .from("users")
      .select("*")
      .eq("spotify_id", spotifyId)
      .single();

    let user = existing.data;

    if (!user) {
      const inserted = await supabase
        .from("users")
        .insert({
          spotify_id: spotifyId,
          spotify_name: null,
          needs_username: true,
        })
        .select()
        .single();

      if (inserted.error) {
        console.error("DB insert error:", inserted.error);
        return res.redirect(FRONTEND_URL + "?error=db_error");
      }
      user = inserted.data;
    }

    const jwtToken = jwt.sign(
      { id: user.id, spotify_id: user.spotify_id, role: user.role || "fan" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    const needsUsername = user.spotify_name ? "false" : "true";
    res.redirect(FRONTEND_URL + "?token=" + jwtToken + "&user_id=" + user.id + "&new_user=" + needsUsername);
  } catch (err) {
    console.error("Spotify auth error:", err.message);
    res.redirect(FRONTEND_URL + "?error=auth_failed");
  }
});function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/auth/me", requireAuth, async (req, res) => {
  const result = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (result.error) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ user: result.data });
});

app.post("/api/set-username", requireAuth, async (req, res) => {
  const name = req.body.name;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: "Name too short" });
  }
  const result = await supabase
    .from("users")
    .update({ spotify_name: name.trim(), needs_username: false })
    .eq("id", req.user.id)
    .select()
    .single();
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ user: result.data });
});

app.get("/api/profile", requireAuth, async (req, res) => {
  const result = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (result.error) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ user: result.data });
});

app.patch("/api/profile", requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.wallet_address) updates.wallet_address = req.body.wallet_address;
  if (req.body.twitter_handle) updates.twitter_handle = req.body.twitter_handle;

  const result = await supabase
    .from("users")
    .update(updates)
    .eq("id", req.user.id)
    .select()
    .single();

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ user: result.data });
});

app.get("/api/campaigns", async (req, res) => {
  const result = await supabase
    .from("campaigns")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ campaigns: result.data });
});

app.post("/api/campaigns", requireAuth, async (req, res) => {
  const body = req.body;
  const result = await supabase
    .from("campaigns")
    .insert({
      operator_id: req.user.id,
      title: body.title,
      description: body.description,
      campaign_type: body.campaign_type,
      target_type: body.target_type,
      artist_name: body.artist_name,
      genre: body.genre,
      reward_pool: body.reward_pool,
      remaining_pool: body.reward_pool,
      duration: body.duration,
      ends_at: body.ends_at,
      status: "active",
    })
    .select()
    .single();

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.status(201).json({ campaign: result.data });
});

app.post("/api/waitlist", async (req, res) => {
  const email = req.body.email;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }
  const result = await supabase
    .from("waitlist")
    .upsert(
      {
        email: email,
        name: req.body.name,
        type: req.body.type || "fan",
        genre_interest: req.body.genre_interest,
      },
      { onConflict: "email", ignoreDuplicates: true }
    )
    .select()
    .single();

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.status(201).json({ message: "Added to waitlist", id: result.data ? result.data.id : null });
});
app.post("/api/campaigns/:id/join", requireAuth, async (req, res) => {
  const wallet = req.body.wallet_address;
  if (!wallet || !wallet.startsWith("0x")) {
    return res.status(400).json({ error: "Valid wallet address required" });
  }

  const campaignRes = await supabase.from("campaigns").select("*").eq("id", req.params.id).single();
  if (campaignRes.error || !campaignRes.data) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  const campaign = campaignRes.data;

  await supabase.from("users").update({ wallet_address: wallet }).eq("id", req.user.id);

  const existingJoin = await supabase
    .from("campaign_participants")
    .select("*")
    .eq("campaign_id", req.params.id)
    .eq("user_id", req.user.id)
    .single();

  if (existingJoin.data) {
    return res.json({ message: "Already joined", participant: existingJoin.data });
  }

  const insertRes = await supabase.from("campaign_participants").insert({
    campaign_id: req.params.id,
    user_id: req.user.id,
    wallet_address: wallet,
    genre: campaign.genre,
  }).select().single();

  if (insertRes.error) {
    return res.status(500).json({ error: insertRes.error.message });
  }

  // Discovery score: check if this genre is new for the user
  const priorGenres = await supabase
    .from("campaign_participants")
    .select("genre")
    .eq("user_id", req.user.id);

  const uniqueGenres = new Set((priorGenres.data || []).map(function(p) { return p.genre; }));
  const discoveryScore = uniqueGenres.size * 10;

  // Streak logic
  const userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  const user = userRes.data;
  const today = new Date().toISOString().split("T")[0];
  let newStreak = user.streak_days || 0;

  if (user.last_active_date !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    newStreak = (user.last_active_date === yesterday) ? newStreak + 1 : 1;
  }

  await supabase.from("users").update({
    discovery_score: discoveryScore,
    last_active_date: today,
    streak_days: newStreak,
  }).eq("id", req.user.id);

  res.json({
    message: "Joined campaign",
    participant: insertRes.data,
    discovery_score: discoveryScore,
    streak_days: newStreak,
    genres_explored: uniqueGenres.size,
  });
});

app.get("/api/leaderboard/discovery", async (req, res) => {
  const result = await supabase
    .from("users")
    .select("spotify_name, discovery_score, streak_days, fan_level")
    .order("discovery_score", { ascending: false })
    .limit(20);

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ leaderboard: result.data });
});
app.post("/api/checkin", requireAuth, async (req, res) => {
  const userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) {
    return res.status(404).json({ error: "User not found" });
  }
  const user = userRes.data;
  const today = new Date().toISOString().split("T")[0];

  if (user.last_active_date === today) {
    return res.json({
      message: "Already checked in today",
      streak_days: user.streak_days || 0,
      reward: 0,
    });
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const newStreak = (user.last_active_date === yesterday) ? (user.streak_days || 0) + 1 : 1;

  let reward = 100;
  if (newStreak % 30 === 0) reward = 5000;
  else if (newStreak % 7 === 0) reward = 1000;

  await supabase.from("users").update({
    streak_days: newStreak,
    last_active_date: today,
    total_pluto: (user.total_pluto || 0) + reward,
  }).eq("id", req.user.id);
await supabase.from("checkins_log").insert({
    user_id: req.user.id,
    reward: reward,
  });
  res.json({
    message: "Checked in!",
    streak_days: newStreak,
    reward: reward,
    total_pluto: (user.total_pluto || 0) + reward,
  });
});
function getTier(score) {
  if (score >= 200) return { name: "Legendary", color: "#fbbf24", icon: "👑" };
  if (score >= 100) return { name: "Platinum", color: "#a78bfa", icon: "💎" };
  if (score >= 50) return { name: "Gold", color: "#fcd34d", icon: "🥇" };
  if (score >= 20) return { name: "Silver", color: "#cbd5e1", icon: "🥈" };
  return { name: "Bronze", color: "#d97706", icon: "🥉" };
}

function streakFlames(days) {
  if (days >= 100) return "🔥🔥🔥";
  if (days >= 30) return "🔥🔥";
  if (days >= 7) return "🔥";
  return "";
}

app.get("/api/leaderboard/:type", async (req, res) => {
  var sortField = "discovery_score";
  if (req.params.type === "streak") sortField = "streak_days";
  if (req.params.type === "earnings") sortField = "total_pluto";

  var result = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score, streak_days, total_pluto, fan_level")
    .order(sortField, { ascending: false })
    .limit(50);

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }

  var enriched = result.data.map(function(u, i) {
    return {
      rank: i + 1,
      id: u.id,
      name: u.spotify_name || "Anonymous Fan",
      discovery_score: u.discovery_score || 0,
      streak_days: u.streak_days || 0,
      total_pluto: u.total_pluto || 0,
      tier: getTier(u.discovery_score || 0),
      flames: streakFlames(u.streak_days || 0),
    };
  });

  res.json({ leaderboard: enriched, type: req.params.type });
});

app.get("/api/leaderboard/:type/me", requireAuth, async (req, res) => {
  var sortField = "discovery_score";
  if (req.params.type === "streak") sortField = "streak_days";
  if (req.params.type === "earnings") sortField = "total_pluto";

  var all = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score, streak_days, total_pluto")
    .order(sortField, { ascending: false });

  if (all.error) {
    return res.status(500).json({ error: all.error.message });
  }

  var idx = all.data.findIndex(function(u) { return u.id === req.user.id; });
  var me = all.data[idx];

  var nearby = all.data.slice(Math.max(0, idx - 2), idx + 3).map(function(u, i) {
    var realIdx = Math.max(0, idx - 2) + i;
    return {
      rank: realIdx + 1,
      id: u.id,
      name: u.spotify_name || "Anonymous Fan",
      discovery_score: u.discovery_score || 0,
      streak_days: u.streak_days || 0,
      total_pluto: u.total_pluto || 0,
      isMe: u.id === req.user.id,
      tier: getTier(u.discovery_score || 0),
      flames: streakFlames(u.streak_days || 0),
    };
  });

  res.json({
    rank: idx + 1,
    total: all.data.length,
    me: me ? {
      name: me.spotify_name || "Anonymous Fan",
      discovery_score: me.discovery_score || 0,
      streak_days: me.streak_days || 0,
      total_pluto: me.total_pluto || 0,
      genres_explored: 0,
      tier: getTier(me.discovery_score || 0),
    } : null,
    nearby: nearby,
  });
});

app.get("/api/genres-explored/:userId", async (req, res) => {
  var result = await supabase
    .from("campaign_participants")
    .select("genre")
    .eq("user_id", req.params.userId);

  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }

  var unique = new Set(result.data.map(function(p) { return p.genre; }));
  res.json({ genres_explored: unique.size, total_genres: 29 });
});
var ALL_GENRES = ["Afrobeats","Amapiano","Hip-Hop","R&B","Pop","Latin","UK Drill","K-Pop","EDM","Gospel","Reggae","Indie","Country","Bollywood","Afropop","Highlife","Bongo Flava","J-Pop","Arabic Pop","OPM","Sertanejo","C-Pop","Salsa","Trap","Ndombolo","Rai","Turkish Pop","Classical","French Pop"];

function tierInfo(score) {
  var tiers = [
    { name: "Bronze", min: 0, max: 20, color: "#d97706", icon: "🥉" },
    { name: "Silver", min: 20, max: 50, color: "#cbd5e1", icon: "🥈" },
    { name: "Gold", min: 50, max: 100, color: "#fcd34d", icon: "🥇" },
    { name: "Platinum", min: 100, max: 200, color: "#a78bfa", icon: "💎" },
    { name: "Legendary", min: 200, max: 999999, color: "#fbbf24", icon: "👑" },
  ];
  var current = tiers[0];
  for (var i = 0; i < tiers.length; i++) {
    if (score >= tiers[i].min) current = tiers[i];
  }
  var next = tiers[tiers.indexOf(current) + 1];
  return {
    name: current.name,
    color: current.color,
    icon: current.icon,
    next: next ? next.name : null,
    pointsToNext: next ? next.min - score : 0,
    progress: next ? Math.round(((score - current.min) / (next.min - current.min)) * 100) : 100,
  };
}

app.get("/api/profile/me", requireAuth, async (req, res) => {
  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) {
    return res.status(404).json({ error: "Not found" });
  }
  var user = userRes.data;

  var genresRes = await supabase
    .from("campaign_participants")
    .select("genre, created_at")
    .eq("user_id", req.user.id);

  var joinedGenres = (genresRes.data || []).map(function(p) { return p.genre; });
  var uniqueGenres = Array.from(new Set(joinedGenres));

  var score = user.discovery_score || 0;
  var streak = user.streak_days || 0;
  var flames = "";
  if (streak >= 100) flames = "🔥🔥🔥";
  else if (streak >= 30) flames = "🔥🔥";
  else if (streak >= 7) flames = "🔥";

  res.json({
    name: user.spotify_name || "Anonymous Fan",
    avatar_url: user.avatar_url || null,
    discovery_score: score,
    streak_days: streak,
    flames: flames,
    total_pluto: user.total_pluto || 0,
    wallet_address: user.wallet_address || null,
    member_since: user.created_at,
    tier: tierInfo(score),
    genres_explored: uniqueGenres,
    genres_count: uniqueGenres.length,
    total_genres: ALL_GENRES.length,
    all_genres: ALL_GENRES,
    campaigns_joined: (genresRes.data || []).length,
  });
});
app.post("/api/profile/avatar", requireAuth, async (req, res) => {
  var imageBase64 = req.body.image;
  if (!imageBase64) {
    return res.status(400).json({ error: "No image provided" });
  }

  try {
    var matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: "Invalid image format" });
    }
    var mimeType = matches[1];
    var ext = mimeType.split("/")[1];
    var base64Data = matches[2];
    var buffer = Buffer.from(base64Data, "base64");

    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "Image too large (max 2MB)" });
    }

    var fileName = req.user.id + "." + ext;

    var uploadRes = await supabase.storage
      .from("avatars")
      .upload(fileName, buffer, { contentType: mimeType, upsert: true });

    if (uploadRes.error) {
      return res.status(500).json({ error: uploadRes.error.message });
    }

    var publicUrl = SUPABASE_URL + "/storage/v1/object/public/avatars/" + fileName;

    await supabase.from("users").update({ avatar_url: publicUrl }).eq("id", req.user.id);

    res.json({ avatar_url: publicUrl });
  } catch (err) {
    console.error("Avatar upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});
// ===== FOLLOW SYSTEM =====
app.get("/api/users/search", async (req, res) => {
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

app.post("/api/follow/:userId", requireAuth, async (req, res) => {
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: "Cannot follow yourself" });
  }
  var result = await supabase.from("follows").insert({
    follower_id: req.user.id,
    following_id: req.params.userId,
  }).select().single();

  if (result.error) {
    if (result.error.code === "23505") return res.json({ message: "Already following" });
    return res.status(500).json({ error: result.error.message });
  }
  res.status(201).json({ message: "Followed" });
});

app.delete("/api/follow/:userId", requireAuth, async (req, res) => {
  var result = await supabase
    .from("follows")
    .delete()
    .eq("follower_id", req.user.id)
    .eq("following_id", req.params.userId);

  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ message: "Unfollowed" });
});

app.get("/api/friends", requireAuth, async (req, res) => {
  var followsRes = await supabase
    .from("follows")
    .select("following_id")
    .eq("follower_id", req.user.id);

  if (followsRes.error) return res.status(500).json({ error: followsRes.error.message });

  var ids = followsRes.data.map(function(f) { return f.following_id; });
  if (ids.length === 0) return res.json({ friends: [] });

  var usersRes = await supabase
    .from("users")
    .select("id, spotify_name, discovery_score, streak_days, avatar_url")
    .in("id", ids);

  if (usersRes.error) return res.status(500).json({ error: usersRes.error.message });

  var friends = usersRes.data.map(function(u) {
    return {
      id: u.id,
      name: u.spotify_name || "Anonymous Fan",
      avatar_url: u.avatar_url || null,
      discovery_score: u.discovery_score || 0,
      streak_days: u.streak_days || 0,
      tier: tierInfo(u.discovery_score || 0),
    };
  });

  res.json({ friends: friends });
});

// ===== RECAP =====
app.get("/api/recap", requireAuth, async (req, res) => {
  var period = req.query.period === "month" ? 30 : 7;
  var since = new Date(Date.now() - period * 86400000).toISOString();

  var checkinsRes = await supabase
    .from("checkins_log")
    .select("reward, created_at")
    .eq("user_id", req.user.id)
    .gte("created_at", since);

  var joinsRes = await supabase
    .from("campaign_participants")
    .select("genre, created_at")
    .eq("user_id", req.user.id)
    .gte("created_at", since);

  if (checkinsRes.error || joinsRes.error) {
    return res.status(500).json({ error: "Failed to load recap" });
  }

  var totalEarned = checkinsRes.data.reduce(function(sum, c) { return sum + (c.reward || 0); }, 0);
  var uniqueGenres = new Set(joinsRes.data.map(function(j) { return j.genre; }));

  res.json({
    period: period === 30 ? "month" : "week",
    checkins: checkinsRes.data.length,
    pluto_earned: totalEarned,
    campaigns_joined: joinsRes.data.length,
    new_genres: uniqueGenres.size,
  });
});
var GENRE_REGIONS = {
  "Afrobeats":"Africa","Amapiano":"Africa","Afropop":"Africa","Highlife":"Africa","Bongo Flava":"Africa","Ndombolo":"Africa","Gospel":"Africa","Rai":"Africa",
  "Hip-Hop":"Americas","R&B":"Americas","Pop":"Americas","Country":"Americas","Indie":"Americas","Trap":"Americas",
  "Latin":"Latin America","Salsa":"Latin America","Sertanejo":"Latin America",
  "UK Drill":"Europe","French Pop":"Europe","Turkish Pop":"Europe","Classical":"Europe",
  "K-Pop":"Asia","J-Pop":"Asia","C-Pop":"Asia","Bollywood":"Asia","OPM":"Asia",
  "EDM":"Global","Reggae":"Global","Arabic Pop":"MENA"
};

app.get("/api/community/stats", async (req, res) => {
  var usersRes = await supabase.from("users").select("id, total_pluto, discovery_score", { count: "exact" });
  var campaignsRes = await supabase.from("campaigns").select("id", { count: "exact" }).eq("status", "active");
  var checkinsRes = await supabase.from("checkins_log").select("reward", { count: "exact" });
  var joinsRes = await supabase.from("campaign_participants").select("id", { count: "exact" });

  var totalPluto = (usersRes.data || []).reduce(function(sum, u) { return sum + (u.total_pluto || 0); }, 0);
  var totalCheckinRewards = (checkinsRes.data || []).reduce(function(sum, c) { return sum + (c.reward || 0); }, 0);

  res.json({
    total_fans: usersRes.count || 0,
    active_campaigns: campaignsRes.count || 0,
    total_checkins: checkinsRes.count || 0,
    total_joins: joinsRes.count || 0,
    total_pluto_distributed: totalPluto + totalCheckinRewards,
  });
});

app.get("/api/quests/daily", async (req, res) => {
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

app.get("/api/badges/me", requireAuth, async (req, res) => {
  var userRes = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (userRes.error) return res.status(404).json({ error: "Not found" });
  var user = userRes.data;

  var genresRes = await supabase.from("campaign_participants").select("genre").eq("user_id", req.user.id);
  var uniqueGenres = new Set((genresRes.data || []).map(function(p) { return p.genre; }));

  var badges = [];
  if ((user.discovery_score || 0) >= 10) badges.push({ name: "First Discovery", icon: "🌱", earned: true });
  if (uniqueGenres.size >= 5) badges.push({ name: "Genre Explorer", icon: "🌍", earned: true });
  if (uniqueGenres.size >= 15) badges.push({ name: "World Traveler", icon: "🗺️", earned: true });
  if ((user.streak_days || 0) >= 7) badges.push({ name: "Week Warrior", icon: "🔥", earned: true });
  if ((user.streak_days || 0) >= 30) badges.push({ name: "Month Master", icon: "🏅", earned: true });
  if ((user.streak_days || 0) >= 100) badges.push({ name: "Century Streak", icon: "💯", earned: true });
  if ((user.discovery_score || 0) >= 100) badges.push({ name: "Platinum Discoverer", icon: "💎", earned: true });
  if ((user.discovery_score || 0) >= 200) badges.push({ name: "Legendary Status", icon: "👑", earned: true });

  res.json({ badges: badges, total_possible: 8 });
});
app.listen(PORT, function () {
  console.log("Pluto Rewards backend running on port " + PORT);
  console.log("Spotify redirect: " + SPOTIFY_REDIRECT_URI);
});
