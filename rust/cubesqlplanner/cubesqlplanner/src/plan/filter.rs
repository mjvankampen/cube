use crate::planner::filter::{BaseFilter, BaseSegment};
use crate::planner::sql_evaluator::MemberSymbol;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::VisitorContext;
use cubenativeutils::CubeError;
use std::fmt;
use std::rc::Rc;

#[derive(Clone, PartialEq)]
pub enum FilterGroupOperator {
    Or,
    And,
}

#[derive(Clone)]
pub struct FilterGroup {
    pub operator: FilterGroupOperator,
    pub items: Vec<FilterItem>,
    /// Set for filters derived from an access policy's `row_level.filters`.
    /// @see FilterItem::row_level_security_cube
    pub row_level_security: bool,
}

impl PartialEq for FilterGroup {
    fn eq(&self, other: &Self) -> bool {
        self.operator == other.operator && self.items == other.items
    }
}

impl FilterGroup {
    pub fn new(operator: FilterGroupOperator, items: Vec<FilterItem>) -> Self {
        Self {
            operator,
            items,
            row_level_security: false,
        }
    }

    pub fn new_row_level_security(operator: FilterGroupOperator, items: Vec<FilterItem>) -> Self {
        Self {
            operator,
            items,
            row_level_security: true,
        }
    }

    /// The same group with its items replaced, keeping the operator and the row level security flag
    pub fn with_items(&self, items: Vec<FilterItem>) -> Self {
        Self {
            operator: self.operator.clone(),
            items,
            row_level_security: self.row_level_security,
        }
    }
}

#[derive(Clone, PartialEq)]
pub enum FilterItem {
    Group(Rc<FilterGroup>),
    Item(Rc<BaseFilter>),
    Segment(Rc<BaseSegment>),
}

#[derive(Clone)]
pub struct Filter {
    pub items: Vec<FilterItem>,
}

impl fmt::Display for FilterGroupOperator {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            FilterGroupOperator::Or => write!(f, "OR"),
            FilterGroupOperator::And => write!(f, "AND"),
        }
    }
}

impl FilterItem {
    pub fn to_sql(
        &self,
        templates: &PlanSqlTemplates,
        context: Rc<VisitorContext>,
    ) -> Result<String, CubeError> {
        let res = match self {
            FilterItem::Group(group) => {
                let operator = format!(" {} ", group.operator.to_string());
                let items_sql = group
                    .items
                    .iter()
                    .map(|itm| itm.to_sql(templates, context.clone()))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .filter(|itm| !itm.is_empty())
                    .collect::<Vec<_>>();
                if items_sql.is_empty() {
                    "".to_string()
                } else {
                    let result = items_sql.join(&operator);
                    format!("({})", result)
                }
            }
            FilterItem::Item(item) => {
                let sql = item.to_sql(context.clone(), templates)?;
                format!("({})", sql)
            }
            FilterItem::Segment(item) => {
                let sql = item.to_sql(context.clone(), templates)?;
                format!("({})", sql)
            }
        };
        Ok(res)
    }

    pub fn is_row_level_security(&self) -> bool {
        match self {
            FilterItem::Group(group) => group.row_level_security,
            FilterItem::Item(item) => item.row_level_security(),
            FilterItem::Segment(_) => false,
        }
    }

    /// Returns the cube a row level security filter is scoped to, or `None` if the filter isn't a
    /// row level security one, spans more than one cube, or can't be attributed to a cube at all.
    /// Only such a single cube filter can be moved from the outer WHERE into the condition of the
    /// join bringing that cube in.
    pub fn row_level_security_cube(&self) -> Option<String> {
        if !self.is_row_level_security() {
            return None;
        }
        let mut result: Option<String> = None;
        for symbol in self.all_member_evaluators() {
            let cube_name = match symbol.as_ref() {
                // Member expressions may reference several cubes, and a subQuery dimension renders
                // as a reference to a join that comes after the one we'd be adding the condition
                // to. Both keep being applied in the outer WHERE.
                MemberSymbol::Dimension(dimension) if !dimension.is_sub_query() => {
                    dimension.cube_name().clone()
                }
                _ => return None,
            };
            match &result {
                None => result = Some(cube_name),
                Some(found) if found == &cube_name => {}
                Some(_) => return None,
            }
        }
        result
    }

    pub fn all_member_evaluators(&self) -> Vec<Rc<MemberSymbol>> {
        let mut result = Vec::new();
        self.find_all_member_evaluators(&mut result);
        result
    }

    pub fn find_all_member_evaluators(&self, result: &mut Vec<Rc<MemberSymbol>>) {
        match self {
            FilterItem::Group(group) => {
                for item in group.items.iter() {
                    item.find_all_member_evaluators(result)
                }
            }
            FilterItem::Item(item) => result.push(item.member_evaluator().clone()),
            FilterItem::Segment(item) => result.push(item.member_evaluator().clone()),
        }
    }
}

impl Filter {
    pub fn to_sql(
        &self,
        templates: &PlanSqlTemplates,
        context: Rc<VisitorContext>,
    ) -> Result<String, CubeError> {
        let res = self
            .items
            .iter()
            .map(|itm| itm.to_sql(templates, context.clone()))
            .collect::<Result<Vec<_>, _>>()?
            .join(" AND ");
        Ok(res)
    }
}
