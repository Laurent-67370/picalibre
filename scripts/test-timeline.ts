// timeline-core.test.ts
import Database from 'better-sqlite3';
import { TimelineCore } from '../src/main/services/timeline/core';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync('src/main/db/migrations/003_timeline.sql', 'utf8'));
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

let db: Database.Database = createInMemoryDb()
let core: TimelineCore = new TimelineCore(db)
const tests: Array<[string, () => void]> = []


  function freshState(): void {
    db = createInMemoryDb();
    core = new TimelineCore(db);
  }

  tests.push(['1. crée une timeline avec les bons champs par défaut', () => { freshState?.();
    const timeline = core.createTimeline('project-1');
    assert.strictEqual(timeline.projectId, 'project-1');
    assert.deepStrictEqual(timeline.videoTracks, []);
    assert.deepStrictEqual(timeline.audioTracks, []);
    assert.strictEqual(timeline.totalDuration, 0);
  }]);

  tests.push(['2. ajoute un clip vidéo sans modifier le fichier source', () => { freshState?.();
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
    assert.strictEqual(clip.sourcePath, '/media/clip1.mp4');
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    assert.strictEqual(row.source_in_offset, 0);
    assert.strictEqual(row.source_out_offset, 10);
  }]);

  tests.push(['3. trim un clip sans altérer sourcePath ni créer de nouveau fichier', () => { freshState?.();
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 10, sourceInOffset: 0, sourceOutOffset: 10,
    });
    core.trimClip(clip.id, 2, 8);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    assert.strictEqual(row.source_in_offset, 2);
    assert.strictEqual(row.source_out_offset, 8);
    assert.strictEqual(row.duration, 6);
    assert.strictEqual(row.source_path, '/media/clip1.mp4');
  }]);

  tests.push(['4. déplace un clip vers un nouveau start_time sur la même piste', () => { freshState?.();
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    core.moveClip(clip.id, 12);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    assert.strictEqual(row.start_time, 12);
  }]);

  tests.push(['5. déplace un clip vers une autre piste (drag cross-track)', () => { freshState?.();
    const timeline = core.createTimeline('project-1');
    const trackA = createVideoTrack(db, timeline.id);
    const trackB = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackA, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    core.moveClip(clip.id, 3, trackB);
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    assert.strictEqual(row.track_id, trackB);
    assert.strictEqual(row.start_time, 3);
  }]);

  tests.push(['6. ajoute une transition crossfade et la lie au clip', () => { freshState?.();
    const timeline = core.createTimeline('project-1');
    const trackId = createVideoTrack(db, timeline.id);
    const clip = core.addClip(trackId, {
      mediaType: 'video', sourcePath: '/media/clip1.mp4',
      startTime: 0, duration: 5, sourceInOffset: 0, sourceOutOffset: 5,
    });
    const transition = core.addTransition(clip.id, 'in', { type: 'crossfade', duration: 1 });
    const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(clip.id) as any;
    assert.strictEqual(row.transition_in_id, transition.id);
    const transitionRow = db.prepare(`SELECT * FROM transitions WHERE id = ?`).get(transition.id) as any;
    assert.strictEqual(transitionRow.type, 'crossfade');
  }]);

  tests.push(['7. calcule totalDuration correctement sur pistes mixtes vidéo/audio', () => { freshState?.();
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
    assert.strictEqual(result?.totalDuration, 15);
  }]);

  tests.push(['8. supprime un clip sans affecter les autres clips de la piste', () => { freshState?.();
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
    assert.strictEqual((result?.videoTracks[0].clips).length, 1);
    assert.strictEqual(result?.videoTracks[0].clips[0].id, clip2.id);
  }]);

// --- Runner séquentiel ---
let passed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    passed++
    console.log('✅', name)
  } catch (e) {
    console.error('❌', name, '\n  ', (e as Error).message)
    process.exit(1)
  }
}
console.log(`\n🎉 Timeline core : ${passed}/${tests.length}`)
