// Archive extraction jobs. Mixed into DatabaseService (see ../db.js).
const { safeJsonParse } = require("../utils");

module.exports = {
  async deleteArchiveJob(jobId) {
    this.db.run("DELETE FROM archive_jobs WHERE id = ?", [jobId]);
    await this.persist();
  },

  listArchiveJobs() {
    return this.query("SELECT * FROM archive_jobs ORDER BY created_at DESC").map((row) => ({
      id: row.id,
      archivePath: row.archive_path,
      archiveName: row.archive_name,
      gameId: row.game_id,
      detectedVersion: row.detected_version,
      status: row.status,
      confidence: row.confidence,
      matchCandidates: safeJsonParse(row.match_candidates, []),
      errorText: row.error_text,
      extractedTo: row.extracted_to,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  },

  findArchiveJobByPath(archivePath, archiveName) {
    return this.first("SELECT * FROM archive_jobs WHERE archive_path = ? AND archive_name = ?", [
      archivePath,
      archiveName
    ]);
  },

  async createArchiveJob(payload) {
    this.db.run(
      `INSERT INTO archive_jobs (
        archive_path, archive_name, archive_hash, game_id, detected_version,
        status, confidence, match_candidates, error_text, extracted_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.archivePath,
        payload.archiveName,
        payload.archiveHash || null,
        payload.gameId || null,
        payload.detectedVersion || null,
        payload.status,
        payload.confidence || null,
        JSON.stringify(payload.matchCandidates || []),
        payload.errorText || null,
        payload.extractedTo || null,
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );
    const insertedId = this.first("SELECT last_insert_rowid() AS id")?.id || null;
    await this.persist();
    return insertedId ? this.first("SELECT * FROM archive_jobs WHERE id = ?", [insertedId]) : null;
  },

  async updateArchiveJob(jobId, updates) {
    const existing = this.first("SELECT * FROM archive_jobs WHERE id = ?", [jobId]);
    if (!existing) {
      throw new Error("Archive job not found.");
    }

    const next = {
      archive_path: updates.archivePath ?? existing.archive_path,
      archive_name: updates.archiveName ?? existing.archive_name,
      archive_hash: updates.archiveHash ?? existing.archive_hash,
      game_id: updates.gameId ?? existing.game_id,
      detected_version: updates.detectedVersion ?? existing.detected_version,
      status: updates.status ?? existing.status,
      confidence: updates.confidence ?? existing.confidence,
      match_candidates: JSON.stringify(updates.matchCandidates ?? safeJsonParse(existing.match_candidates, [])),
      error_text: updates.errorText ?? existing.error_text,
      extracted_to: updates.extractedTo ?? existing.extracted_to,
      updated_at: new Date().toISOString()
    };

    this.db.run(
      `UPDATE archive_jobs SET
        archive_path = ?, archive_name = ?, archive_hash = ?, game_id = ?, detected_version = ?, status = ?,
        confidence = ?, match_candidates = ?, error_text = ?, extracted_to = ?, updated_at = ?
      WHERE id = ?`,
      [
        next.archive_path,
        next.archive_name,
        next.archive_hash,
        next.game_id,
        next.detected_version,
        next.status,
        next.confidence,
        next.match_candidates,
        next.error_text,
        next.extracted_to,
        next.updated_at,
        jobId
      ]
    );
    await this.persist();
    return this.first("SELECT * FROM archive_jobs WHERE id = ?", [jobId]);
  }
};
