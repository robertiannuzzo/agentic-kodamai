module Recruitment.Adapters.Cases

import public Recruitment.Application.Workflow

%default total

export
data CaseMemory = Cases Nat (List CaseRecord)

export
emptyCases : CaseMemory
emptyCases = Cases 1 []

lookupCase : Nat -> List CaseRecord -> Either DomainError CaseRecord
lookupCase _ [] = Left NotFound
lookupCase ref (row :: rest) = if row.reference == ref then Right row else lookupCase ref rest

loadCase : Nat -> CaseMemory -> Either DomainError CaseRecord
loadCase ref (Cases _ rows) = lookupCase ref rows

commitCase : Maybe Nat -> CaseRecord -> CaseMemory -> Either DomainError CaseMemory
commitCase expected row (Cases next rows) =
  case (expected, lookupCase row.reference rows) of
    (Nothing, Left NotFound) =>
      if row.reference == next && row.generation == 0
        then Right (Cases (S next) (row :: rows)) else Left StaleVersion
    (Just version, Right old) =>
      if old.generation == version && row.generation == S version
        then Right (Cases next (map (\r => if r.reference == row.reference then row else r) rows))
        else Left StaleVersion
    _ => Left StaleVersion

export
caseRepository : CaseRepository CaseMemory
caseRepository = MkCaseRepository (\(Cases next _) => next) loadCase commitCase
