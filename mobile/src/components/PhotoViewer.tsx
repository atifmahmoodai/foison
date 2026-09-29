import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, space } from "../theme";
import { Text } from "./ui";

/** One photo at full screen width; tall receipt photos scroll vertically instead of shrinking to fit. */
function Page({ uri, width }: { uri: string; width: number }) {
  const [aspect, setAspect] = useState<number | null>(null);
  return (
    <ScrollView style={{ width }} contentContainerStyle={styles.pageContent} maximumZoomScale={4} minimumZoomScale={1} centerContent>
      <Image
        source={{ uri }}
        style={{ width, height: aspect ? width * aspect : width }}
        resizeMode="contain"
        onLoad={(e) => {
          const { width: w, height: h } = e.nativeEvent.source;
          if (w > 0) setAspect(h / w);
        }}
      />
    </ScrollView>
  );
}

export function PhotoViewer({ uris, visible, onClose }: { uris: string[]; visible: boolean; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} onShow={() => setIndex(0)}>
      <View style={styles.container}>
        <FlatList
          data={uris}
          keyExtractor={(uri) => uri}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => <Page uri={item} width={width} />}
        />
        <View style={[styles.topBar, { top: insets.top + space.md }]}>
          {uris.length > 1 ? (
            <View style={styles.counter}>
              <Text variant="caption" style={{ color: "#fff" }}>
                Part {index + 1} of {uris.length}
              </Text>
            </View>
          ) : (
            <View />
          )}
          <Pressable accessibilityLabel="Close photos" onPress={onClose} style={styles.close}>
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  pageContent: { flexGrow: 1, justifyContent: "center" },
  topBar: { position: "absolute", left: space.lg, right: space.lg, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  counter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.18)" },
  close: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
});
