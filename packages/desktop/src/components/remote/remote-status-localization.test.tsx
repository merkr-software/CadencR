import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { RemoteStatus } from "@/api/generated";
import { Toaster } from "@/components/ui/sonner";
import { useRemotePairingToast } from "@/hooks/useRemotePairingToast";
import { useRemoteUpdateCheck } from "@/hooks/useRemoteUpdateCheck";
import { uiI18n } from "@/lib/i18n/ui";
import frFR from "@/lib/i18n/catalogs/fr-FR.json";
import { showRemoteConnectedToast } from "@/lib/remote/connection-toast";
import * as deviceToken from "@/lib/remote/device-token";
import { useRemoteDialogStore } from "@/stores/remote-dialog-store";
import { useRemoteStore } from "@/stores/remote-store";
import { act, render, screen } from "@/test-utils";
import { RemoteAccessButton } from "./RemoteAccessButton";
import { RemoteActivitySection } from "./RemoteActivitySection";
import { RemoteLanSection } from "./RemoteLanSection";
import { RemoteDevicesSection } from "./RemoteDevicesSection";

vi.mock("@/lib/remote/device-token", () => ({
  isBrowserRemote: () => true,
  trustCurrentDevice: () => true,
}));
vi.mock("@/lib/remote/update-check", () => ({ isUpdateAvailable: async () => true }));

const remoteStatus: RemoteStatus = {
  audit_tail: [],
  connected_devices: 0,
  devices: [],
  enabled: true,
  lan_urls: [],
  pairing_state: "none",
};

const switchLanguage = (language: string) => act(() => uiI18n.changeLanguage(language));

afterEach(async () => {
  await switchLanguage("en");
  uiI18n.removeResourceBundle("fr", "ui");
  vi.restoreAllMocks();
  useRemoteDialogStore.setState({ open: false, focusDevicesNonce: 0 });
  sessionStorage.clear();
  toast.dismiss();
});

it("formats the host badge and paired-device count for the display language", async () => {
  const count = 1234;
  const { status, loaded } = useRemoteStore.getState();
  vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(false);
  vi.spyOn(useRemoteStore.getState(), "refresh").mockResolvedValue(undefined);
  useRemoteStore.setState({
    loaded: true,
    status: {
      ...remoteStatus,
      connected_devices: count,
      devices: Array.from({ length: count }, (_, id) => ({
        id,
        created_at: "2026-11-25 12:00:00",
      })),
    },
  });

  const view = render(<RemoteAccessButton />);
  try {
    const badge = screen.getByRole("button", { name: /Remote access ON/ });
    const english = new Intl.NumberFormat("en").format(count);
    expect(badge.textContent).toBe(english);
    expect(badge).toHaveAttribute("aria-label", `Remote access ON — ${english} devices connected`);

    await switchLanguage("fr-FR");
    const french = new Intl.NumberFormat("fr-FR").format(count);
    expect(badge.textContent).toBe(french);
    expect(badge).toHaveAttribute(
      "aria-label",
      frFR.ui.remote.host.connected_other.replace("{{count, number}}", french),
    );

    await view.user.click(badge);
    const frenchDevices = frFR.ui.remote.host.sections.devices.replace("{{deviceCount}}", french);
    const devices = await screen.findByRole("button", {
      name: (label) => label.replace(/\s+/gu, " ") === frenchDevices.replace(/\s+/gu, " "),
    });
    expect(devices.textContent).toBe(frenchDevices);
    await switchLanguage("en");
    expect(devices.textContent).toBe(`Paired devices (${english})`);
  } finally {
    view.unmount();
    useRemoteStore.setState({ status, loaded });
  }
});

it("updates device and activity labels during a pending revoke, preserving raw data", async () => {
  const now = Date.UTC(2026, 10, 25);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const date = new Date(now - 1234 * 86_400_000).toISOString();
  const request = Promise.withResolvers<void>();
  const revoke = vi
    .spyOn(useRemoteStore.getState(), "revokeDevice")
    .mockReturnValue(request.promise);
  const status: RemoteStatus = {
    ...remoteStatus,
    devices: [{ id: 5, label: "iPhone d’Ada", created_at: date }],
    audit_tail: [
      { event: "pair", detail: "Safari 18.1", created_at: date },
      { event: "future_event", created_at: "raw timestamp" },
    ],
  };
  const { user } = render(
    <>
      <RemoteDevicesSection status={status} />
      <RemoteActivitySection status={status} />
    </>,
  );
  const button = screen.getByRole("button", { name: "Revoke iPhone d’Ada" });
  expect(screen.getByText("Last seen never · paired 1,234d ago")).toBeVisible();
  await user.click(button);
  expect(button).toBeDisabled();

  uiI18n.addResourceBundle("fr", "ui", {
    remote: {
      devices: {
        timestamps: "Associé {{pairedAt}} · dernière activité {{lastSeen}}",
        revoke: "Révoquer",
        revokeNamed: "Révoquer {{name}}",
        revokeTitle: "Révoquer cet appareil",
      },
      activity: { devicePaired: "Appareil associé" },
      age: { never: "jamais" },
    },
    time: { relative: { daysAgo: "il y a {{number}} j" } },
  });
  await switchLanguage("fr");
  expect(screen.getByRole("button", { name: "Révoquer iPhone d’Ada" })).toBe(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "Révoquer cet appareil");
  expect(button).toHaveAttribute("aria-busy", "true");
  const days = new Intl.NumberFormat("fr").format(1234);
  expect(
    screen.getByText(`Associé il y a ${days} j · dernière activité jamais`, {
      normalizer: (value) => value,
    }),
  ).toBeVisible();
  expect(screen.getByText("Appareil associé")).toBeVisible();
  expect(screen.getByText("iPhone d’Ada")).toBeVisible();
  expect(screen.getByText("Safari 18.1")).toBeVisible();
  expect(screen.getByText("future_event")).toBeVisible();
  expect(screen.getByText("raw timestamp")).toBeVisible();

  await switchLanguage("en");
  expect(screen.getByRole("button", { name: "Revoke iPhone d’Ada" })).toBe(button);
  expect(screen.getByText("Device paired")).toBeVisible();
  expect(button).toBeDisabled();
  expect(revoke).toHaveBeenCalledExactlyOnceWith(5);
  await act(async () => request.resolve());
  expect(button).toBeEnabled();
});

function RemoteToasts() {
  useRemotePairingToast();
  useRemoteUpdateCheck();
  return <Toaster />;
}

it("retranslates remote toast actions in place and preserves the device dialog target", async () => {
  sessionStorage.setItem("cadencr.remoteJustPaired", "session");
  const { user } = render(<RemoteToasts />);
  act(() => showRemoteConnectedToast());

  const reload = await screen.findByRole("button", { name: "Reload" });
  const devices = screen.getByRole("button", { name: "View devices" });
  const staySignedIn = screen.getByRole("button", { name: "Stay signed in" });
  uiI18n.addResourceBundle("fr", "ui", {
    common: { reload: "Recharger" },
    system: {
      toasts: { close: "Fermer la notification", notifications: "Notifications récentes" },
    },
    remote: {
      activity: { deviceConnected: "Appareil connecté" },
      connection: { viewDevices: "Voir les appareils" },
      pairing: { staySignedIn: "Rester connecté" },
      update: { available: "Une nouvelle version est disponible" },
    },
  });
  await switchLanguage("fr");
  expect(screen.getByRole("button", { name: "Recharger" })).toBe(reload);
  expect(screen.getByRole("button", { name: "Voir les appareils" })).toBe(devices);
  expect(screen.getByRole("button", { name: "Rester connecté" })).toBe(staySignedIn);
  expect(screen.getByRole("region", { name: /^Notifications récentes/ })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Fermer la notification" })).toHaveLength(3);
  expect(screen.getByText("Appareil connecté")).toBeInTheDocument();
  expect(screen.getByText("Une nouvelle version est disponible")).toBeInTheDocument();

  await switchLanguage("en");
  expect(screen.getByRole("button", { name: "Reload" })).toBe(reload);
  expect(screen.getByRole("button", { name: "View devices" })).toBe(devices);
  expect(screen.getByRole("button", { name: "Stay signed in" })).toBe(staySignedIn);
  expect(screen.getAllByRole("button", { name: "Close toast" })).toHaveLength(3);
  await user.click(devices);
  expect(useRemoteDialogStore.getState()).toMatchObject({ open: true, focusDevicesNonce: 1 });
});

it("keeps clipboard feedback in the active language during and after a pending write", async () => {
  const value = "https://192.0.2.1:5005";
  const pending = Promise.withResolvers<void>();
  const { user } = render(
    <>
      <RemoteLanSection status={{ ...remoteStatus, lan_urls: [value] }} />
      <Toaster />
    </>,
  );
  const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  uiI18n.addResource("fr", "ui", "remote.lan.urlCopied", "Adresse copiée");
  await switchLanguage("fr");
  await act(async () => pending.resolve());
  expect(await screen.findByText("Adresse copiée")).toBeVisible();
  await switchLanguage("en");
  expect(await screen.findByText("URL copied")).toBeVisible();
  expect(write).toHaveBeenCalledExactlyOnceWith(value);
});
