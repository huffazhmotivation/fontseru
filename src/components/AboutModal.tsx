import { useState } from "react";
import { Mail, MessageCircle, X } from "lucide-react";
import { FontSeruLogo } from "@/components/FontSeruLogo";

// WhatsApp deep link for the "About" contact, built the same way
// `getProWhatsAppUrl` does it in `lib/whatsapp.ts`: digits only,
// leading 0 swapped for Indonesia's country code.
const ABOUT_WHATSAPP_NUMBER = "089636921421";
const ABOUT_EMAIL = "tandaseru.co@gmail.com";

function getAboutWhatsAppUrl(): string {
  const digits = ABOUT_WHATSAPP_NUMBER.replace(/[^0-9]/g, "").replace(/^0/, "62");
  return `https://wa.me/${digits}`;
}

/**
 * Small "About" trigger button + modal. Fully self-contained (owns its
 * own open/close state) so it can be dropped anywhere — e.g. the TopBar —
 * without touching the global app store.
 */
export function AboutModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="fm-topbtn"
        onClick={() => setOpen(true)}
        title="Tentang FontSeru"
        data-testid="about-btn"
      >
        About Us
      </button>

      {open ? (
        <div
          className="fm-auth-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <div className="fm-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="about-modal-title">
            <header>
              <div className="fm-pro-modal-heading">
                <FontSeruLogo />
                <h2 id="about-modal-title" style={{ marginLeft: 8 }}>
                  Tentang FontSeru
                </h2>
              </div>
              <button
                type="button"
                className="fm-overlay-close"
                onClick={() => setOpen(false)}
                aria-label="Tutup"
                data-testid="about-modal-close"
              >
                <X size={17} />
              </button>
            </header>

            <div className="fm-auth-form">
              <p className="fm-auth-note">
                FontSeru is a simple web-based font creation tool for designing glyphs, refining
                spacing, testing type, and exporting fonts—independently developed with inspiration
                from Fontma and XsisLab.com.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                <a
                  className="fm-auth-note"
                  href={`mailto:${ABOUT_EMAIL}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
                  data-testid="about-modal-email"
                >
                  <Mail size={15} /> {ABOUT_EMAIL}
                </a>
                <a
                  className="fm-auth-note"
                  href={getAboutWhatsAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
                  data-testid="about-modal-whatsapp"
                >
                  <MessageCircle size={15} /> WhatsApp 0896 3692 1421
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
