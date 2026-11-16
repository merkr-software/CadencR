"""Exact, reviewed GitHub environment reviewer policy; never infer defaults."""


def fail(code):
    raise SystemExit(code)


def identities(reviewers, remote=False):
    if not isinstance(reviewers, list) or not 1 <= len(reviewers) <= 6:
        fail('AUTHOR_REVIEW_POLICY_INVALID' if not remote else 'AUTHOR_ENVIRONMENT_UNPROTECTED')
    result = set()
    for reviewer in reviewers:
        if not isinstance(reviewer, dict):
            fail('AUTHOR_ENVIRONMENT_UNPROTECTED' if remote else 'AUTHOR_REVIEW_POLICY_INVALID')
        identity = reviewer.get('reviewer') if remote else reviewer
        if (not isinstance(identity, dict) or reviewer.get('type') not in ('User', 'Team')
                or type(identity.get('id')) is not int or identity['id'] <= 0
                or (not remote and set(reviewer) != {'type', 'id'})):
            fail('AUTHOR_ENVIRONMENT_UNPROTECTED' if remote else 'AUTHOR_REVIEW_POLICY_INVALID')
        key = (reviewer['type'], identity['id'])
        if key in result:
            fail('AUTHOR_ENVIRONMENT_UNPROTECTED' if remote else 'AUTHOR_REVIEW_POLICY_INVALID')
        result.add(key)
    return result


def validate_review_policy(policy, environment_id):
    if (not isinstance(policy, dict)
            or set(policy) != {'environment_id', 'prevent_self_review', 'reviewers'}
            or type(environment_id) is not int or environment_id <= 0
            or type(policy.get('environment_id')) is not int
            or policy['environment_id'] != environment_id
            or type(policy.get('prevent_self_review')) is not bool):
        fail('AUTHOR_REVIEW_POLICY_INVALID')
    return (policy['prevent_self_review'], identities(policy['reviewers']))


def validate_remote_reviewers(rules, reviewed):
    if (len(rules) != 1
            or type(rules[0].get('prevent_self_review')) is not bool
            or rules[0]['prevent_self_review'] is not reviewed[0]
            or identities(rules[0].get('reviewers'), remote=True) != reviewed[1]):
        fail('AUTHOR_ENVIRONMENT_UNPROTECTED')
