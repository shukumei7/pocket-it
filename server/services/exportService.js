class ExportService {
  exportCSV(data, columns) {
    if (!data || data.length === 0) return '';

    const cols = columns || Object.keys(data[0]);
    const header = cols.map(c => `"${c}"`).join(',');
    const rows = data.map(row =>
      cols.map(c => {
        const val = row[c];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Escape quotes and wrap if contains comma/quote/newline
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',')
    );
    return [header, ...rows].join('\n');
  }

  async exportPDF(reportData) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(20).fillColor('#1b2838').text(reportData.title || 'Pocket IT Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#666')
        .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
      if (reportData.dateRange) {
        doc.text(`Period: ${reportData.dateRange}`, { align: 'center' });
      }
      doc.moveDown(1);

      // Summary stats
      if (reportData.stats) {
        doc.fontSize(14).fillColor('#1b2838').text('Summary');
        doc.moveDown(0.3);
        for (const [label, value] of Object.entries(reportData.stats)) {
          doc.fontSize(10).fillColor('#333').text(`${label}: ${value}`);
        }
        doc.moveDown(1);
      }

      // Data table
      if (reportData.rows && reportData.rows.length > 0) {
        const columns = reportData.columns || Object.keys(reportData.rows[0]);
        doc.fontSize(14).fillColor('#1b2838').text('Details');
        doc.moveDown(0.3);

        // Table header
        doc.fontSize(8).fillColor('#1b2838');
        const colWidth = (doc.page.width - 100) / columns.length;
        let x = 50;
        for (const col of columns) {
          doc.text(col, x, doc.y, { width: colWidth, continued: false });
          x += colWidth;
        }
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke('#ccc');
        doc.moveDown(0.3);

        // Table rows
        doc.fontSize(8).fillColor('#333');
        for (const row of reportData.rows) {
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
          }
          x = 50;
          const startY = doc.y;
          for (const col of columns) {
            const val = row[col] !== null && row[col] !== undefined ? String(row[col]) : '';
            doc.text(val, x, startY, { width: colWidth });
            x += colWidth;
          }
          doc.moveDown(0.3);
        }
      }

      doc.end();
    });
  }
}

module.exports = ExportService;
