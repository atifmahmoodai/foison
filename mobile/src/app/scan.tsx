import Ionicons from "@expo/vector-icons/Ionicons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Text } from "../components/ui";
import { space, useTheme } from "../theme";

/** Photos per receipt. Tall photos are also sliced on-device; see lib/tiling.ts. */
const MAX_PAGES = 8;

function goToReview(pages: string[]) {
  router.replace({ pathname: "/review", params: { pages: JSON.stringify(pages) } });
}

async function pickFromLibrary(limit: number): Promise<string[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 1,
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    orderedSelection: true,
  });
  return result.canceled ? [] : result.assets.map((a) => a.uri);
}

function PermissionGate({ canAskAgain, onRequest }: { canAskAgain: boolean; onRequest: () => void }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.permission, { backgroundColor: colors.background }]}>
      <View style={{ alignItems: "flex-end" }}>
        <Pressable accessibilityLabel="Close" onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={28} color={colors.text} />
        </Pressable>
      </View>
      <View style={{ gap: space.md, alignItems: "center" }}>
        <Ionicons name="camera-outline" size={48} color={colors.accent} />
        <Text variant="title" style={{ textAlign: "center" }}>
          Camera access needed
        </Text>
        <Text tone="muted" style={{ textAlign: "center" }}>
          Foison uses your camera to photograph receipts. Photos stay on your device and are only sent to read the items.
        </Text>
      </View>
      <View style={{ gap: space.sm }}>
        {canAskAgain ? (
          <Button title="Allow camera" onPress={onRequest} />
        ) : (
          <Button title="Open Settings" onPress={() => void Linking.openSettings()} />
        )}
        <Button
          title="Choose from library"
          variant="secondary"
          icon="images-outline"
          onPress={async () => {
            const picked = await pickFromLibrary(MAX_PAGES);
            if (picked.length) goToReview(picked);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pages, setPages] = useState<string[]>([]);

  if (!permission) return <View style={{ flex: 1, backgroundColor: "#000" }} />;
  if (!permission.granted) {
    return <PermissionGate canAskAgain={permission.canAskAgain} onRequest={() => void requestPermission()} />;
  }

  const full = pages.length >= MAX_PAGES;

  const capture = async () => {
    if (!camera.current || !ready || capturing || full) return;
    setCapturing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9 });
      setPages((p) => [...p, photo.uri]);
    } catch (error) {
      console.warn("Capture failed", error);
      Alert.alert("Couldn't take photo", "Please try again.");
    } finally {
      setCapturing(false);
    }
  };

  const addFromLibrary = async () => {
    const picked = await pickFromLibrary(MAX_PAGES - pages.length);
    if (picked.length) goToReview([...pages, ...picked]);
  };

  const removeLast = () => {
    void Haptics.selectionAsync();
    setPages((p) => p.slice(0, -1));
  };

  const close = () => {
    if (pages.length === 0) return router.back();
    Alert.alert("Discard photos?", `You've taken ${pages.length} photo${pages.length > 1 ? "s" : ""} of this receipt.`, [
      { text: "Keep scanning", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => router.back() },
    ]);
  };

  const hint =
    pages.length === 0
      ? "Fit the receipt in the frame. Long receipt? Shoot it in parts, top to bottom."
      : full
        ? `Maximum ${MAX_PAGES} parts reached. Tap Done.`
        : `Part ${pages.length} captured. Move down so the next photo overlaps a little, or tap Done.`;

  return (
    <View style={styles.container}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        onCameraReady={() => setReady(true)}
        onMountError={(e) => Alert.alert("Camera unavailable", e.message)}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <RoundButton icon="close" label="Close" onPress={close} />
          <RoundButton icon={torch ? "flash" : "flash-off"} label="Toggle flash" onPress={() => setTorch((t) => !t)} />
        </View>
        <View style={styles.hint}>
          <Text variant="caption" style={{ color: "#fff", textAlign: "center" }}>
            {hint}
          </Text>
        </View>

        <View style={styles.frame} pointerEvents="none">
          {(["tl", "tr", "bl", "br"] as const).map((corner) => (
            <View key={corner} style={[styles.corner, styles[corner]]} />
          ))}
        </View>

        <View style={styles.bottomBar}>
          {pages.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Remove last photo" onPress={removeLast} style={styles.thumbWrap}>
              <Image source={{ uri: pages[pages.length - 1] }} style={styles.thumb} />
              <View style={styles.thumbBadge}>
                <Text variant="caption" style={{ color: "#0B0F14", fontWeight: "700" }}>
                  {pages.length}
                </Text>
              </View>
              <View style={styles.thumbUndo}>
                <Ionicons name="arrow-undo" size={12} color="#fff" />
              </View>
            </Pressable>
          ) : (
            <RoundButton icon="images-outline" label="Choose from library" onPress={() => void addFromLibrary()} />
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pages.length ? "Take next part" : "Take photo"}
            onPress={() => void capture()}
            disabled={!ready || capturing || full}
            style={({ pressed }) => [
              styles.shutter,
              { opacity: ready && !full ? 1 : 0.4, transform: [{ scale: pressed ? 0.94 : 1 }] },
            ]}
          >
            {capturing ? <ActivityIndicator color="#0B0F14" /> : <View style={styles.shutterInner} />}
          </Pressable>

          {pages.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Done" onPress={() => goToReview(pages)} style={styles.done}>
              <Ionicons name="checkmark" size={20} color="#0B0F14" />
              <Text variant="bodyStrong" style={{ color: "#0B0F14" }}>
                Done
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: 56 }} />
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={styles.round}>
      <Ionicons name={icon} size={22} color="#fff" />
    </Pressable>
  );
}

const CORNER = 34;
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.sm },
  hint: {
    alignSelf: "center",
    marginTop: space.md,
    marginHorizontal: space.xl,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  frame: { flex: 1, marginHorizontal: space.xl, marginVertical: space.lg },
  corner: { position: "absolute", width: CORNER, height: CORNER, borderColor: "#fff" },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
  bottomBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingBottom: space.lg },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#fff" },
  thumbWrap: { width: 56, height: 56 },
  thumb: { width: 56, height: 56, borderRadius: 12, borderWidth: 2, borderColor: "#fff" },
  thumbBadge: {
    position: "absolute",
    top: -8,
    right: -8,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbUndo: {
    position: "absolute",
    bottom: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  done: { flexDirection: "row", alignItems: "center", gap: 4, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: "#fff" },
  permission: { flex: 1, padding: space.xl, justifyContent: "space-between" },
});
