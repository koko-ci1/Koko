const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "KÔKÔ", version: "Render test" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname,"index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KÔKÔ running on port ${PORT}`);
});
