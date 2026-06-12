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

app.listen(PORT, function () {
  console.log("Pluto Rewards backend running on port " + PORT);
  console.log("Spotify redirect: " + SPOTIFY_REDIRECT_URI);
});
