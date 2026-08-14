import express from "express";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

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

const storage = new Storage();
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
// Start
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Funeral RSVP running on http://localhost:${PORT}`);
});
