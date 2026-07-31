"use client";

import { useEffect, useState } from "react";

import { useAppTranslation } from "@/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ProfileSectionProps {
  displayName: string;
  onSave: (displayName: string) => Promise<void>;
}

export function ProfileSection({
  displayName: initialName,
  onSave,
}: ProfileSectionProps) {
  const { t } = useAppTranslation("settings");
  const [displayName, setDisplayName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setDisplayName(initialName);
  }, [initialName]);

  const trimmedDisplayName = displayName.trim();
  const hasChanges = trimmedDisplayName !== initialName;
  const canSubmit = trimmedDisplayName.length > 0 && hasChanges;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedDisplayName) {
      setFeedback({
        type: "error",
        message: t("profile.displayNameEmpty"),
      });
      return;
    }

    setSaving(true);
    setFeedback(null);

    try {
      await onSave(trimmedDisplayName);
      setFeedback({ type: "success", message: t("profile.feedback.updated") });
    } catch {
      setFeedback({
        type: "error",
        message: t("profile.feedback.updateFailed"),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("profile.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("profile.description")}
        </p>
      </div>

      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="mb-4">
          <h3 className="text-base font-semibold">
            {t("profile.profileTitle")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("profile.profileDescription")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="max-w-md space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">{t("profile.displayName")}</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("profile.displayNamePlaceholder")}
            />
          </div>

          {feedback && (
            <p
              className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
            >
              {feedback.message}
            </p>
          )}

          <Button type="submit" disabled={saving || !canSubmit} size="sm">
            {saving ? t("profile.saving") : t("profile.save")}
          </Button>
        </form>
      </div>
    </div>
  );
}
