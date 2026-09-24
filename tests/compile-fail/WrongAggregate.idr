module WrongAggregate
import Recruitment.Adapters.Transition
%default total

-- A review handler that answers with the loaded aggregate instead of the next one.
bad : Agent ReviewC
bad = answers (\(row, ref, expected, c, decision) => Right (MkNext row Refl Refl))
