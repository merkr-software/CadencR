//! IronCalc: loads the workbook, evaluates every formula, and reports each
//! result as a [`CellResult`] — or nothing, when IronCalc can't compute it.

use std::panic::{self, AssertUnwindSafe};

use ironcalc::base::expressions::token::Error as EngineError;
use ironcalc::base::types::{Cell, FormulaValue};
use ironcalc::base::Model;
use ironcalc::import::load_from_xlsx_bytes;

use super::archive::SheetPart;
use super::cells::CellResult;
use crate::domain::schedules::local_zone::local_timezone;

/// Formulas are stored in the file in English whatever Excel's UI language.
const FORMULA_LANGUAGE: &str = "en";
const LOCALE: &str = "en";

pub(super) struct Evaluated(Model<'static>);

/// IronCalc indexes into the XML it expects and panics on valid files that
/// omit an optional part (a styles part without `<cellStyles>`), so a panic
/// is one more way for it to fail on a workbook — never the request's end.
pub(super) fn evaluate(bytes: &[u8], sheets: &[SheetPart]) -> Result<Evaluated, String> {
    panic::catch_unwind(AssertUnwindSafe(|| load_and_evaluate(bytes, sheets))).unwrap_or_else(
        |payload| {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|text| text.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            tracing::warn!(detail, "formula engine panicked on a workbook");
            Err("The formula engine crashed on this workbook".into())
        },
    )
}

fn load_and_evaluate(bytes: &[u8], sheets: &[SheetPart]) -> Result<Evaluated, String> {
    // `TODAY()` / `NOW()` follow the machine's time zone, as they do in Excel.
    let workbook = load_from_xlsx_bytes(bytes, "workbook", LOCALE, &local_timezone())
        .map_err(|e| format!("The formula engine couldn't read this workbook: {e}"))?;
    let mut model = Model::from_workbook(workbook, FORMULA_LANGUAGE)
        .map_err(|e| format!("The formula engine couldn't load this workbook: {e}"))?;
    let engine_names = model.workbook.worksheets.iter().map(|sheet| &sheet.name);
    if !engine_names.eq(sheets.iter().map(|sheet| &sheet.name)) {
        return Err("The formula engine read a different set of sheets".into());
    }
    model.evaluate();
    Ok(Evaluated(model))
}

impl Evaluated {
    /// The result of the formula at (`sheet`, `row`, `column`), 1-based.
    /// `None` when IronCalc doesn't implement a function the formula uses or
    /// can't parse it: those are IronCalc's limits, not the workbook's
    /// errors, so they must not be shown as the formula's value.
    pub fn result(&self, sheet: u32, row: i32, column: i32) -> Option<CellResult> {
        let cell = self.0.workbook.worksheet(sheet).ok()?.cell(row, column)?;
        let value = match cell {
            Cell::CellFormula { v, .. } | Cell::ArrayFormula { v, .. } => v,
            _ => return None,
        };
        match value {
            FormulaValue::Unevaluated => None,
            FormulaValue::Number(number) if number.is_finite() => Some(CellResult::Number(*number)),
            FormulaValue::Number(_) => Some(CellResult::Error("#NUM!".into())),
            FormulaValue::Text(text) => Some(CellResult::Text(text.clone())),
            FormulaValue::Boolean(value) => Some(CellResult::Boolean(*value)),
            FormulaValue::Error { ei, .. } => excel_error(ei).map(CellResult::Error),
        }
    }
}

/// The literal Excel itself would show. IronCalc's own codes (unimplemented
/// function, unparsed formula, circular reference) have no Excel equivalent.
fn excel_error(error: &EngineError) -> Option<String> {
    match error {
        EngineError::NIMPL | EngineError::ERROR | EngineError::CIRC => None,
        EngineError::REF
        | EngineError::NAME
        | EngineError::VALUE
        | EngineError::DIV
        | EngineError::NA
        | EngineError::NUM
        | EngineError::SPILL
        | EngineError::CALC
        | EngineError::NULL => Some(error.to_string()),
    }
}
