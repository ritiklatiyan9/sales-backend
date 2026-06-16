// Minimal CRUD base, mirroring the accounting backend's MasterModel.
class MasterModel {
  constructor(tableName) {
    this.tableName = tableName;
  }

  async findById(id, pool) {
    const { rows } = await pool.query(`SELECT * FROM ${this.tableName} WHERE id = $1`, [id]);
    return rows[0];
  }

  async create(data, pool) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO ${this.tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return rows[0];
  }

  async update(id, data, pool) {
    const keys = Object.keys(data);
    if (!keys.length) return this.findById(id, pool);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = [...Object.values(data), id];
    const { rows } = await pool.query(
      `UPDATE ${this.tableName} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0];
  }
}

export default MasterModel;
