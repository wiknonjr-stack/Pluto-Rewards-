require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 4000;

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET,
  SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
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

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
// robots.txt
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "User-agent: GPTBot", "Disallow: /",
    "User-agent: ClaudeBot", "Disallow: /",
    "User-agent: anthropic-ai", "Disallow: /",
    "User-agent: CCBot", "Disallow: /",
    "User-agent: *", "Allow: /",
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
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/auth/spotify/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?error=${error}`);

  try {
    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
        },
      }
    );

    const { access_token } = tokenRes.data;

    const profileRes = await axios.get("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const profile = profileRes.data;

    const { data: user, error: dbErr } = await supabase
      .from("users")
      .upsert({
        spotify_id: profile.id,
        spotify_name: profile.display_name || profile.id,
        spotify_image: profile.images?.[0]?.url || null,
        email: profile.email || null,
      }, { onConflict: "spotify_id" })
      .select()
      .single();

    if (dbErr) {
      console.error("DB error:", dbErr);
      return res.redirect(`${FRONTEND_URL}?error=db_error`);
    }

    const jwtToken = jwt.sign(
      { id: user.id, spotify_id: user.spotify_id, role: user.role || "fan" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.redirect(`${FRONTEND_URL}?token=${jwtToken}&user_id=${user.id}&name=${encodeURIComponent(user.spotify_name)}`);
  } catch (err) {
    console.error("Spotify auth error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});
