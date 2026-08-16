import express from "express";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import nunjucks from "nunjucks";

const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
  throw new Error("ADMIN_SECRET environment variable is required");
}

const app = express();

const PORT = process.env.PORT || 3000;
const BUCKET_NAME = process.env.RSVP_BUCKET_NAME;

if (!BUCKET_NAME) {
  throw new Error("RSVP_BUCKET_NAME environment variable is required");
}

// --------------------------------------------------
// Setup
// --------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

nunjucks.configure(path.join(__dirname, "templates"), {
  autoescape: true,
  express: app,
});

app.set("view engine", "html");

let storage;

if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  // Local development using JSON key

  storage = new Storage({
    keyFilename: path.resolve(
      __dirname,

      process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    ),
  });
} else {
  // Cloud Run uses its attached service account

  storage = new Storage();
}

const bucket = storage.bucket(BUCKET_NAME);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function normalisePhone(phone) {
  return phone.replace(/\D/g, "");
}

function getRsvpId(phone) {
  return crypto
    .createHash("sha256")
    .update(normalisePhone(phone))
    .digest("hex");
}

// --------------------------------------------------
// Routes
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/rsvp", async (req, res) => {
  try {
    const { familyName, phone, attending, guestCount } = req.body;

    // --------------------------
    // Validation
    // --------------------------

    if (!familyName?.trim()) {
      return res.status(400).json({
        error: "Family name is required",
      });
    }

    if (!phone?.trim()) {
      return res.status(400).json({
        error: "Phone number is required",
      });
    }

    if (typeof attending !== "boolean") {
      return res.status(400).json({
        error: "Attending must be true or false",
      });
    }

    let count = 0;

    if (attending) {
      count = Number(guestCount);

      if (!Number.isInteger(count) || count < 1 || count > 20) {
        return res.status(400).json({
          error: "Guest count must be between 1 and 20",
        });
      }
    }

    // --------------------------
    // Create ID from phone
    // --------------------------

    const normalisedPhone = normalisePhone(phone);

    if (normalisedPhone.length < 7) {
      return res.status(400).json({
        error: "Please enter a valid phone number",
      });
    }

    const rsvpId = getRsvpId(phone);

    const file = bucket.file(`rsvps/${rsvpId}.json`);

    // --------------------------
    // Check if RSVP exists
    // --------------------------

    let createdAt = new Date().toISOString();

    try {
      const [existingData] = await file.download();

      const existingRsvp = JSON.parse(existingData.toString());

      createdAt = existingRsvp.createdAt || createdAt;
    } catch (error) {
      // File doesn't exist yet.
      // That's fine — this is a new RSVP.
      if (error.code !== 404) {
        throw error;
      }
    }

    // --------------------------
    // Save RSVP
    // --------------------------

    const now = new Date().toISOString();

    const rsvp = {
      familyName: familyName.trim(),
      phone: phone.trim(),

      attending,
      guestCount: attending ? count : 0,

      createdAt,
      updatedAt: now,
    };

    await file.save(JSON.stringify(rsvp, null, 2), {
      resumable: false,
      contentType: "application/json",
    });

    console.log(
      `RSVP saved: ${familyName} - ${attending ? "attending" : "not attending"}`,
    );

    return res.status(200).json({
      success: true,
      message: "RSVP saved successfully",
    });
  } catch (error) {
    console.error("Failed to save RSVP:", error);

    return res.status(500).json({
      error: "Unable to save RSVP",
    });
  }
});

// --------------------------------------------------
// Admin - Export RSVPs
// --------------------------------------------------

app.post("/api/admin/export-rsvps", async (req, res) => {
  try {
    const { secret } = req.body;

    // --------------------------
    // Authentication
    // --------------------------

    if (!secret || secret !== ADMIN_SECRET) {
      return res.status(401).json({
        error: "Unauthorised",
      });
    }

    // --------------------------
    // Create local RSVP directory
    // --------------------------

    const rsvpDirectory = path.join(__dirname, "RSVPs");

    await fs.mkdir(rsvpDirectory, {
      recursive: true,
    });

    // --------------------------
    // Get every RSVP JSON
    // --------------------------

    const [files] = await bucket.getFiles({
      prefix: "rsvps/",
    });

    const jsonFiles = files.filter((file) => file.name.endsWith(".json"));

    const rsvps = [];

    // --------------------------
    // Download JSON files
    // --------------------------

    for (const file of jsonFiles) {
      const [contents] = await file.download();

      const rsvp = JSON.parse(contents.toString("utf8"));

      rsvps.push(rsvp);

      const localFilename = path.basename(file.name);

      const localPath = path.join(rsvpDirectory, localFilename);

      await fs.writeFile(localPath, JSON.stringify(rsvp, null, 2), "utf8");
    }

    // --------------------------
    // Sort by family name
    // --------------------------

    rsvps.sort((a, b) =>
      (a.familyName || "").localeCompare(b.familyName || ""),
    );

    // --------------------------
    // Build CSV
    // --------------------------

    const headers = [
      "Family Name",
      "Phone",
      "Attending",
      "Number Attending",
      "Created",
      "Last Updated",
    ];

    const rows = rsvps.map((rsvp) => [
      rsvp.familyName,
      rsvp.phone,
      rsvp.attending ? "Yes" : "No",
      rsvp.guestCount,
      rsvp.createdAt,
      rsvp.updatedAt,
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");

    // --------------------------
    // Save CSV
    // --------------------------

    const csvPath = path.join(rsvpDirectory, "rsvps.csv");

    await fs.writeFile(csvPath, csv, "utf8");

    console.log(`Exported ${rsvps.length} RSVPs`);

    // --------------------------
    // Return CSV download
    // --------------------------

    return res.download(csvPath, "Eve-Funeral-RSVPs.csv");
  } catch (error) {
    console.error("Failed to export RSVPs:", error);

    return res.status(500).json({
      error: "Unable to export RSVPs",
    });
  }
});

// --------------------------------------------------
// CSV helper
// --------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  return `"${stringValue.replace(/"/g, '""')}"`;
}

app.get("/service", async (req, res) => {
  try {
    const servicePath = path.join(__dirname, "data", "service.json");

    const contents = await fs.readFile(servicePath, "utf8");

    const service = JSON.parse(contents);

    return res.render("service.html", {
      service,
    });
  } catch (error) {
    console.error("Failed to load service:", error);

    return res.status(500).send("Unable to load service");
  }
});

// --------------------------------------------------
// Start
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Funeral RSVP running on http://localhost:${PORT}`);
});
