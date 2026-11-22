#!/bin/sh
# Generates the two 150 s WebM "lectures" used by the mock site (VP8/Opus: open-source
# Chromium has no H.264). Output is gitignored.
set -eu
out="$(cd "$(dirname "$0")" && pwd)/fixtures/media"
mkdir -p "$out"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=25:duration=150" \
  -f lavfi -i "sine=frequency=440:duration=150" -c:v libvpx -b:v 300k -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 32k "$out/lecture1.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=25:duration=150" \
  -f lavfi -i "sine=frequency=660:duration=150" -c:v libvpx -b:v 300k -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 32k "$out/lecture2.webm"
# Class101-shaped HLS for test/speed-e2e.mjs: H.264 TS video variant + packed AAC audio rendition.
mkdir -p "$out/class101"
( cd "$out/class101" &&
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=60" -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 -an \
    -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_filename 'v%03d.ts' video.m3u8 &&
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" -ac 2 -c:a aac -b:a 96k \
    -f segment -segment_time 6 -segment_format adts -segment_list audio.m3u8 -segment_list_type m3u8 'a%03d.aac' &&
  printf '#EXTM3U\n#EXT-X-VERSION:1\n#EXT-X-MEDIA:LANGUAGE="en",AUTOSELECT=YES,TYPE=AUDIO,URI="audio.m3u8?Policy=p",GROUP-ID="default-audio-group",DEFAULT=NO,NAME="stream_1"\n#EXT-X-MEDIA:AUTOSELECT=NO,TYPE=AUDIO,URI="audio.m3u8?Policy=p",GROUP-ID="default-audio-group",DEFAULT=NO,NAME="vocals"\n#EXT-X-STREAM-INF:CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30,BANDWIDTH=600000,AUDIO="default-audio-group"\nvideo.m3u8?Policy=p\n' > master.m3u8 )
ls -la "$out"
# Audio rendition for the SpeedAudio test: master with an EXT-X-MEDIA audio group
# pointing at 5 s WAV segments (open-source Chromium can't decode AAC).
mkdir -p "$out/speed"
for i in 0 1 2 3 4 5; do
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=5" -ac 2 "$out/speed/seg$i.wav"
done
{ printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n'; for i in 0 1 2 3 4 5; do printf '#EXTINF:5.0,\nseg%s.wav?Policy=p\n' $i; done; printf '#EXT-X-ENDLIST\n'; } > "$out/speed/audio.m3u8"
printf '#EXTM3U\n#EXT-X-MEDIA:AUTOSELECT=YES,TYPE=AUDIO,URI="audio.m3u8?Policy=p",GROUP-ID="g",DEFAULT=NO,NAME="stream_1"\n#EXT-X-MEDIA:AUTOSELECT=NO,TYPE=AUDIO,URI="vocals.m3u8",GROUP-ID="g",DEFAULT=NO,NAME="vocals"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="g"\n720.m3u8\n' > "$out/speed/master.m3u8"
ls -la "$out"
