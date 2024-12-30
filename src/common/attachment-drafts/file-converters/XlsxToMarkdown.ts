// import { convertToHtml, images } from 'mammoth';
import { read, utils } from 'xlsx';
interface President {
  Name: string;
  Index: number;
}

export async function convertXlsxToHTML(input: ArrayBuffer): Promise<{ html: string }> {
  try {
    const wb = read(input); // parse the array buffer
    const ws = wb.Sheets[wb.SheetNames[0]]; // get the first worksheet
    const data: President[] = utils.sheet_to_json<President>(ws); // generate objects
    return { html: JSON.stringify(data) };
  } catch (error) {
    console.error('Error converting XLSX to Markdown:', error);
    throw error;
  }
}
