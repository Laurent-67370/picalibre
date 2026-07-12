// timeline-core.test.ts
import Database from 'better-sqlite3';
import { TimelineCore } from './timeline-core';
import { beforeEach, describe, it, expect } from 'vitest';

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE timelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY,
      timeline_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('video', 'audio')),
      order_index INTEGER NOT NULL,
      gain REAL DEFAULT 1.0,
      muted INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1,
      FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
    );
    CREATE TABLE clips (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video', 'audio')),
      source_path TEXT NOT NULL,
      start_time REAL NOT NULL,
      duration REAL NOT NULL,
      source_in_offset REAL DEFAULT 0,
      source_out_offset REAL NOT NULL,
      transition_in_id TEXT,
      transition_out_id TEXT,
      volume REAL DEFAULT 1.0,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    CREATE TABLE transitions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('crossfade', 'wipe', 'slide')),
      duration REAL NOT NULL,
      direction TEXT
    );
  `);
  return db;
}

function createVideoTrack(db: Database.Database, timelineId: string): string {
  const trackId = crypto.randomUUID();
  db.prepare(`INSERT INTO tracks (id, timeline_id, type, order_index) VALUES (?, ?, 'video', 0)`)
    .run(trackId, timelineId);
  return trackId;
}

function createAudioTrack(db: Database.Database, timelineId: string): string {
  const trackId = crypto.randomUUID();
  db.prepare(`INSERT INTO tracks (id, timeline_id, type, order_index) VALUES (?, ?, 'audio', 1)`)
    .run(trackId, timelineId);
  return trackId;
}
describe('TimelineCore', () => {
  let db: Database.Database;
  let core: TimelineCore;

  beforeEach(() => {
    db = createInMemoryDb();
    core = new TimelineCore(db);
  });

  it('1. crée une timeline avec les bons champs par défaut', () => {
    const timeline = core.createTimeline('project-1');
    expect(timeline.projectId).toBe('project-1');
    expect(timeline.videoTracks).toEqual([]);
    expect(timeline.audioTracks).toEqual([]);
    expect(timeline.totalDuration).toBe(0);
  });

  it('2. ajoute un clip vidéo sans modifier le fichier source', () => {
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video',
      sourcePath: '/media/clip1.mp4',
      startTime: 0,
      duration: 10,
      sourceInOffset: 0,
      sourceOutOffset: 10,
    });
    expect(clip.sourcePath).toBe('/media/clip1.mp4');
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    expect(row.source_in_offset).toBe(0);
    expect(row.source_out_offset).toBe(10);
  });

  it('3. trim un clip sans altérer sourcePath ni créer de nouveau fichier', () => {
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 10, sourceInOffset: 0, sourceOutOffset: 10,
    });
    core.trimClip(clip.id, 2, 8);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    expect(row.source_in_offset).toBe(2);
    expect(row.source_out_offset).toBe(8);
    expect(row.duration).toBe(6);
    expect(row.source_path).toBe('/media/clip1.mp4');
  });

  it('4. déplace un clip vers un nouveau start_time sur la même piste', () => {
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    core.moveClip(clip.id, 12);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    expect(row.start_time).toBe(12);
  });

  it('5. déplace un clip vers une autre piste (drag cross-track)', () => {
    const timeline = core.createTimeline('project-1');
    const trackA = createVideoTrack(db, timeline.id);
    const trackB = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackA, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    core.moveClip(clip.id, 3, trackB);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    expect(row.track_id).toBe(trackB);
    expect(row.start_time).toBe(3);
  });

  it('6. ajoute une transition crossfade et la lie au clip', () => {
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    const transition = core.addTransition(clip.id, 'in', { type: 'crossfade', duration: 1 });
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    expect(row.transition_in_id).toBe(transition.id);
    const transitionRow = db.prepare(`SELECT * FROM transitions WHERE id = ?`).get(transition.id) as any;
    expect(transitionRow.type).toBe('crossfade');
  });

  it('7. calcule totalDuration correctement sur pistes mixtes vidéo/audio', () => {
    const timeline = core.createTimeline('project-1');
    const videoTrack = createVideoTrack(db, timeline.id);
    const audioTrack = createAudioTrack(db, timeline.id);
    core.addClip(videoTrack, {
      mediaType: 'video', sourcePath: '/media/v.mp4',
      startTime: 0, duration: 8, sourceInOffset: 0, sourceOutOffset: 8,
    });
    core.addClip(audioTrack, {
      mediaType: 'audio', sourcePath: '/media/a.mp3',
      startTime: 5, duration: 10, sourceInOffset: 0, sourceOutOffset: 10,
    });
    const result = core.getTimeline(timeline.id);
    expect(result?.totalDuration).toBe(15);
  });

  it('8. supprime un clip sans affecter les autres clips de la piste', () => {
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip1 = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/a.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    const clip2 = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/b.mp4',
      startTime: 5, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    core.deleteClip(clip1.id);
    const result = core.getTimeline(timeline.id);
    expect(result?.videoTracks[0].clips).toHaveLength(1);
    expect(result?.videoTracks[0].clips[0].id).toBe(clip2.id);
  });
});
