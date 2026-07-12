import Database from 'better-sqlite3';

export type MediaType = 'photo' | 'video' | 'audio';

export interface TimelineClip {
  id: string;
  trackId: string;
  mediaType: MediaType;
  sourcePath: string;
  startTime: number;
  duration: number;
  sourceInOffset: number;
  sourceOutOffset: number;
  transitionInId?: string;
  transitionOutId?: string;
  volume?: number;
}

export interface Transition {
  id: string;
  type: 'crossfade' | 'wipe' | 'slide';
  duration: number;
  direction?: 'left' | 'right' | 'up' | 'down';
}

export interface AudioTrack {
  id: string;
  clips: TimelineClip[];
  gain: number;
  muted: boolean;
}

export interface VideoTrack {
  id: string;
  clips: TimelineClip[];
  visible: boolean;
}

export interface Timeline {
  id: string;
  projectId: string;
  videoTracks: VideoTrack[];
  audioTracks: AudioTrack[];
  totalDuration: number;
  createdAt: number;
  updatedAt: number;
}

export class TimelineCore {
  constructor(private db: Database.Database) {}

  createTimeline(projectId: string): Timeline {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO timelines (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, projectId, now, now);
    return { id, projectId, videoTracks: [], audioTracks: [], totalDuration: 0, createdAt: now, updatedAt: now };
  }

  addClip(trackId: string, clip: Omit<TimelineClip, 'id' | 'trackId'>): TimelineClip {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO clips (id, track_id, media_type, source_path, start_time, duration,
        source_in_offset, source_out_offset, transition_in_id, transition_out_id, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, trackId, clip.mediaType, clip.sourcePath, clip.startTime, clip.duration,
      clip.sourceInOffset, clip.sourceOutOffset, clip.transitionInId ?? null,
      clip.transitionOutId ?? null, clip.volume ?? 1.0);
    return { id, trackId, ...clip };
  }

  trimClip(clipId: string, newInOffset: number, newOutOffset: number): void {
    const newDuration = newOutOffset - newInOffset;
    this.db.prepare(`
      UPDATE clips SET source_in_offset = ?, source_out_offset = ?, duration = ?
      WHERE id = ?
    `).run(newInOffset, newOutOffset, newDuration, clipId);
  }

  moveClip(clipId: string, newStartTime: number, newTrackId?: string): void {
    if (newTrackId) {
      this.db.prepare(`UPDATE clips SET start_time = ?, track_id = ? WHERE id = ?`)
        .run(newStartTime, newTrackId, clipId);
    } else {
      this.db.prepare(`UPDATE clips SET start_time = ? WHERE id = ?`).run(newStartTime, clipId);
    }
  }

  addTransition(clipId: string, position: 'in' | 'out', transition: Omit<Transition, 'id'>): Transition {
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO transitions (id, type, duration, direction) VALUES (?, ?, ?, ?)`)
      .run(id, transition.type, transition.duration, transition.direction ?? null);
    const column = position === 'in' ? 'transition_in_id' : 'transition_out_id';
    this.db.prepare(`UPDATE clips SET ${column} = ? WHERE id = ?`).run(id, clipId);
    return { id, ...transition };
  }

  getTimeline(timelineId: string): Timeline | null {
    const timeline = this.db.prepare(`SELECT * FROM timelines WHERE id = ?`).get(timelineId) as any;
    if (!timeline) return null;

    const tracks = this.db.prepare(`SELECT * FROM tracks WHERE timeline_id = ? ORDER BY order_index`)
      .all(timelineId) as any[];

    const videoTracks: VideoTrack[] = [];
    const audioTracks: AudioTrack[] = [];

    for (const track of tracks) {
      const clips = this.db.prepare(`SELECT * FROM clips WHERE track_id = ? ORDER BY start_time`)
        .all(track.id) as any[];

      const mappedClips: TimelineClip[] = clips.map(c => ({
        id: c.id, trackId: c.track_id, mediaType: c.media_type, sourcePath: c.source_path,
        startTime: c.start_time, duration: c.duration, sourceInOffset: c.source_in_offset,
        sourceOutOffset: c.source_out_offset, transitionInId: c.transition_in_id,
        transitionOutId: c.transition_out_id, volume: c.volume,
      }));

      if (track.type === 'video') {
        videoTracks.push({ id: track.id, clips: mappedClips, visible: !!track.visible });
      } else {
        audioTracks.push({ id: track.id, clips: mappedClips, gain: track.gain, muted: !!track.muted });
      }
    }

    const totalDuration = Math.max(
      0,
      ...[...videoTracks, ...audioTracks].flatMap(t => t.clips.map(c => c.startTime + c.duration))
    );

    return { id: timeline.id, projectId: timeline.project_id, videoTracks, audioTracks,
      totalDuration, createdAt: timeline.created_at, updatedAt: timeline.updated_at };
  }

  deleteClip(clipId: string): void {
    this.db.prepare(`DELETE FROM clips WHERE id = ?`).run(clipId);
  }
}
