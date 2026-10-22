import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
// The library's pure-JS core — no Node or canvas dependencies, works everywhere
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('qrcode/lib/core/qrcode') as {
  create: (text: string, opts?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }) => {
    modules: { size: number; get: (row: number, col: number) => boolean | number };
  };
};

/** A scannable QR code for `value`, drawn as dark squares on white. */
export function JoinQR({ value, size = 200 }: { value: string; size?: number }) {
  const { path, cells } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const quiet = 2; // white border so phone cameras can find the edges
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.modules.get(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    return { path: d, cells: n + quiet * 2 };
  }, [value]);

  return (
    <View style={{ width: size, height: size, borderRadius: 16, overflow: 'hidden', backgroundColor: '#fff' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`}>
        <Rect x={0} y={0} width={cells} height={cells} fill="#fff" />
        <Path d={path} fill="#0A0D1B" />
      </Svg>
    </View>
  );
}
