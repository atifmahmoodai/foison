import Ionicons from "@expo/vector-icons/Ionicons";
import { randomUUID } from "expo-crypto";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Easing, Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AmountField, Field, ItemEditor } from "../components/ItemEditor";
import { ItemRow, TotalLine } from "../components/ItemRow";
import { Button, Card, Divider, MerchantAvatar, Text } from "../components/ui";
import { parseReceiptParts } from "../lib/api";
import { AuthError } from "../lib/auth";
import { formatMoney } from "../lib/format";
import { CancelledError, HttpError } from "../lib/http";
import { deleteCacheFiles, prepareReceiptPages } from "../lib/image";
import { draftFromExtraction, effectiveTotal, itemsTotal, saveDraft, totalsMismatch, validateDraft, type Draft } from "../lib/receipts";
import type { ReceiptItem } from "../lib/types";
import { radius, space, useTheme } from "../theme";

type State =
  | { phase: "processing" }
  | { phase: "error"; message: string; retryable: boolean }
  | { phase: "ready"; draft: Draft; pageUris: string[] };

function errorMessage(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof AuthError) return { message: error.message, retryable: false };
  if (error instanceof HttpError) {
    const retake = error.code === "not_a_receipt" || error.code === "unparseable" || error.code === "refused";
    return { message: error.message, retryable: !retake };
  }
  return { message: "Something went wrong while reading the receipt.", retryable: true };
}

function parsePages(raw: string | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Returns null if cancelled. Resized pages are reported via onPrepared so they can be cleaned up. */
async function readReceipt(pages: string[], signal: AbortSignal, onPrepared: (uris: string[]) => void): Promise<State | null> {
  try {
    const prepared = await prepareReceiptPages(pages.map((uri) => ({ uri })));
    onPrepared(prepared.pageUris);
    if (signal.aborted) return null;
    const extracted = await parseReceiptParts(prepared.parts, signal);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return { phase: "ready", draft: draftFromExtraction(extracted), pageUris: prepared.pageUris };
  } catch (error) {
    if (error instanceof CancelledError || signal.aborted) return null;
    console.warn("Receipt processing failed", error);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    return { phase: "error", ...errorMessage(error) };
  }
}

function ScanningPreview({ uri }: { uri: string }) {
  const { colors } = useTheme();
  const [progress] = useState(() => new Animated.Value(0));
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(progress, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(height - 4, 0)] });
  return (
    <View style={styles.previewWrap} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.25)" }]} />
      <Animated.View style={[styles.scanLine, { backgroundColor: colors.accent, shadowColor: colors.accent, transform: [{ translateY }] }]} />
    </View>
  );
}

export default function ReviewScreen() {
  const params = useLocalSearchParams<{ pages: string }>();
  const pages = useMemo(() => parsePages(params.pages), [params.pages]);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [state, setState] = useState<State>({ phase: "processing" });
  const [editing, setEditing] = useState<{ item: ReceiptItem | null; index: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef(false);
  const inFlight = useRef<AbortController | null>(null);
  const tempFiles = useRef(new Set<string>());

  const process = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    void readReceipt(pages, controller.signal, (uris) => uris.forEach((u) => tempFiles.current.add(u))).then((next) => {
      if (next && !controller.signal.aborted) setState(next);
    });
  }, [pages]);

  useEffect(() => {
    if (pages.length) process();
  }, [pages, process]);

  // Leaving the screen cancels the upload (the server then stops the Claude call too) and removes
  // temporary images. Saved receipts already have their own copies in app storage.
  useEffect(() => {
    const files = tempFiles.current;
    return () => {
      inFlight.current?.abort();
      deleteCacheFiles([...pages, ...files]);
    };
  }, [pages]);

  // Ask before throwing away a reviewed-but-unsaved receipt.
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (saved.current || state.phase !== "ready") return;
      e.preventDefault();
      Alert.alert("Discard this receipt?", "The items you reviewed won't be saved.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
      ]);
    });
  }, [navigation, state.phase]);

  if (pages.length === 0) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text tone="muted">No photo to read.</Text>
      </View>
    );
  }

  if (state.phase === "processing") {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, gap: space.xl }]}>
        <ScanningPreview uri={pages[0]!} />
        <View style={{ gap: space.xs, alignItems: "center" }}>
          <Text variant="headline">
            {pages.length > 1 ? `Reading ${pages.length} parts…` : "Reading your receipt…"}
          </Text>
          <Text tone="muted" style={{ textAlign: "center" }}>
            {pages.length > 1
              ? "Joining the parts and extracting every item and price. Long receipts can take up to a minute."
              : "Extracting every item and price. This usually takes a few seconds."}
          </Text>
        </View>
        <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  if (state.phase === "error") {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, gap: space.lg }]}>
        <View style={[styles.errorIcon, { backgroundColor: colors.dangerSoft }]}>
          <Ionicons name="alert-circle-outline" size={32} color={colors.danger} />
        </View>
        <Text variant="headline" style={{ textAlign: "center" }}>
          {state.message}
        </Text>
        <View style={{ alignSelf: "stretch", gap: space.sm }}>
          {state.retryable ? (
            <Button
              title="Try again"
              icon="refresh"
              onPress={() => {
                setState({ phase: "processing" });
                process();
              }}
            />
          ) : null}
          <Button
            title="Retake photo"
            icon="camera-outline"
            variant={state.retryable ? "secondary" : "primary"}
            onPress={() => router.replace("/scan")}
          />
        </View>
      </View>
    );
  }

  const { draft, pageUris } = state;
  const update = (patch: Partial<Draft>) => setState({ ...state, draft: { ...draft, ...patch } });
  const mismatch = totalsMismatch(draft);

  const saveItem = (item: ReceiptItem) => {
    if (!editing) return;
    const items = [...draft.items];
    if (editing.index >= 0) items[editing.index] = item;
    else items.push({ ...item, id: randomUUID() });
    update({ items });
    setEditing(null);
  };

  const removeItem = () => {
    if (!editing || editing.index < 0) return;
    update({ items: draft.items.filter((_, i) => i !== editing.index) });
    setEditing(null);
  };

  const onSave = async () => {
    const problem = validateDraft(draft);
    if (problem) return Alert.alert("Check the receipt", problem);
    setSaving(true);
    try {
      const id = await saveDraft(draft, pageUris);
      saved.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: "/receipt/[id]", params: { id } });
    } catch (error) {
      console.warn("Save failed", error);
      Alert.alert("Couldn't save", "Something went wrong saving this receipt. Please try again.");
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={100}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <MerchantAvatar name={draft.merchant} size={52} />
            <TextInput
              value={draft.merchant}
              onChangeText={(merchant) => update({ merchant })}
              placeholder="Store name"
              placeholderTextColor={colors.textFaint}
              style={[styles.merchant, { color: colors.text }]}
            />
          </View>
          <View style={{ flexDirection: "row", gap: space.md }}>
            <Field label="Date (YYYY-MM-DD)" value={draft.purchaseDate} onChangeText={(purchaseDate) => update({ purchaseDate })} keyboardType="numbers-and-punctuation" />
            <View style={{ width: 100 }}>
              <Field label="Currency" value={draft.currency} onChangeText={(c) => update({ currency: c.toUpperCase().slice(0, 3) })} />
            </View>
          </View>
        </Card>

        {mismatch ? (
          <View style={[styles.banner, { backgroundColor: colors.warningSoft }]}>
            <Ionicons name="warning-outline" size={20} color={colors.warning} />
            <Text variant="caption" style={{ color: colors.warning, flex: 1 }}>
              The items add up to {formatMoney(itemsTotal(draft), draft.currency)}, but the receipt total is{" "}
              {formatMoney(draft.total ?? 0, draft.currency)}. Tap an item to fix it.
            </Text>
          </View>
        ) : null}

        {draft.notes ? (
          <View style={[styles.banner, { backgroundColor: colors.surfaceMuted }]}>
            <Ionicons name="information-circle-outline" size={20} color={colors.textMuted} />
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              {draft.notes}
            </Text>
          </View>
        ) : null}

        <Card style={{ paddingVertical: space.sm }}>
          <View style={styles.cardHeader}>
            <Text variant="headline">{draft.items.length} items</Text>
            <Text variant="caption" tone="faint">
              Tap to edit
            </Text>
          </View>
          {draft.items.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Divider /> : null}
              <ItemRow item={item} currency={draft.currency} onPress={() => setEditing({ item, index })} />
            </View>
          ))}
          <Button title="Add item" icon="add" variant="ghost" onPress={() => setEditing({ item: null, index: -1 })} />
        </Card>

        <Card style={{ gap: space.sm }}>
          <TotalLine label="Items" value={formatMoney(itemsTotal(draft), draft.currency)} />
          <View style={{ flexDirection: "row", gap: space.md }}>
            <AmountField label="Tax" value={draft.tax} onChange={(tax) => update({ tax })} placeholder="0.00" />
            <AmountField
              label="Total paid"
              value={draft.total}
              onChange={(total) => update({ total })}
              placeholder={effectiveTotal(draft).toFixed(2)}
            />
          </View>
          <Divider />
          <TotalLine label="Total" value={formatMoney(effectiveTotal(draft), draft.currency)} strong />
        </Card>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md, backgroundColor: colors.background, borderColor: colors.border }]}>
        <Button title="Save & add to Google Sheets" icon="checkmark-circle" onPress={() => void onSave()} loading={saving} />
      </View>

      <ItemEditor
        visible={editing !== null}
        item={editing?.item ?? null}
        onClose={() => setEditing(null)}
        onSave={saveItem}
        onDelete={editing && editing.index >= 0 ? removeItem : undefined}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  previewWrap: { width: 220, height: 300, borderRadius: radius.lg, overflow: "hidden" },
  preview: { width: "100%", height: "100%" },
  scanLine: { position: "absolute", left: 0, right: 0, height: 3, shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  errorIcon: { width: 64, height: 64, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  merchant: { flex: 1, fontSize: 22, fontWeight: "700", letterSpacing: -0.4, paddingVertical: 4 },
  banner: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: "flex-start" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.sm },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
});
